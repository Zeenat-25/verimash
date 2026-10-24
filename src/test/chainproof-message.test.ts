
import { expect } from "chai";
import hre from "hardhat";

describe("ChainProof - Cross-Chain Messaging", function () {
  it("sends, receives, audits, and protects a cross-chain message", async function () {

    // STEP 1: Deploy existing Hyperlane mock mailboxes
    const Mailbox = await hre.ethers.getContractFactory("MockMailbox");

    const mailboxA = await Mailbox.deploy(1000);
    await mailboxA.deployed();

    const mailboxB = await Mailbox.deploy(2000);
    await mailboxB.deployed();

    await (await mailboxA.addRemoteMailbox(2000, mailboxB.address)).wait();
    await (await mailboxB.addRemoteMailbox(1000, mailboxA.address)).wait();

    console.log("Chain A Domain: 1000");
    console.log("Chain B Domain: 2000");

    // STEP 2: Deploy our modified HelloWorld contracts
    const HelloWorld = await hre.ethers.getContractFactory("HelloWorld");

    const appA = await HelloWorld.deploy(
      mailboxA.address,
      await mailboxA.defaultHook()
    );
    await appA.deployed();

    const appB = await HelloWorld.deploy(
      mailboxB.address,
      await mailboxB.defaultHook()
    );
    await appB.deployed();

    // STEP 3: Register trusted remote routers
    const routerA = hre.ethers.utils.hexZeroPad(appA.address, 32);
    const routerB = hre.ethers.utils.hexZeroPad(appB.address, 32);

    await (await appA.enrollRemoteRouter(2000, routerB)).wait();
    await (await appB.enrollRemoteRouter(1000, routerA)).wait();

    // STEP 4: Send a cross-domain message
    const message = "Hello from Chain A!";
    const messageBytes = hre.ethers.utils.toUtf8Bytes(message);

    const fee = await appA.quoteDispatch(2000, messageBytes);

    const tx = await appA.sendHelloWorld(2000, message, {
      value: fee,
    });

    await tx.wait();

    expect(await appA.sent()).to.equal(1);
    expect(await appB.received()).to.equal(0);

    console.log("Message dispatched!");

    // STEP 5: Process message at destination
    const processTx = await mailboxB.processNextInboundMessage();
    const processReceipt = await processTx.wait();

    expect(await appB.received()).to.equal(1);
    expect(await appB.receivedFrom(1000)).to.equal(1);

    console.log("Message received successfully!");

    // STEP 6: Verify our custom ChainProof audit receipt
    const payloadHash = hre.ethers.utils.keccak256(messageBytes);

    const expectedAuditId = hre.ethers.utils.keccak256(
      hre.ethers.utils.defaultAbiCoder.encode(
        ["uint32", "bytes32", "bytes", "uint256"],
        [1000, routerA, messageBytes, 0]
      )
    );

    expect(await appB.auditRecorded(expectedAuditId)).to.equal(true);
    expect(await appB.verifyAuditReceipt(expectedAuditId)).to.equal(true);
    expect((await appB.totalAuditReceipts()).toString()).to.equal("1");

    // STEP 7: Verify the actual blockchain audit event
    const events = await appB.queryFilter(
      appB.filters.ChainProofReceipt(),
      processReceipt.blockNumber,
      processReceipt.blockNumber
    );

    expect(events.length).to.equal(1);

    const auditEvent = events[0];

    expect(auditEvent.args?.auditId).to.equal(expectedAuditId);
    expect(auditEvent.args?.origin.toString()).to.equal("1000");

    // Normalize hexadecimal case to avoid checksum differences
    expect(
      String(auditEvent.args?.sender).toLowerCase()
    ).to.equal(routerA.toLowerCase());

    expect(auditEvent.args?.payloadHash).to.equal(payloadHash);

    console.log("CHAINPROOF AUDIT VERIFIED!");
    console.log("Audit ID:", expectedAuditId);
    console.log("Payload Hash:", payloadHash);
    console.log("Total Audit Receipts: 1");

    // STEP 8: Test existing Hyperlane replay protection
    console.log("Attempting replay attack...");

    await expect(
      mailboxB.processInboundMessage(0)
    ).to.be.revertedWith("Mailbox: already delivered");

    // Verify the replay did not create another receipt
    expect((await appB.received()).toString()).to.equal("1");
    expect((await appB.totalAuditReceipts()).toString()).to.equal("1");

    console.log("SECURITY PASSED: Replay attack rejected!");

    // STEP 9: Final test summary
    console.log("================================");
    console.log("CHAINPROOF FINAL TEST RESULTS");
    console.log("================================");
    console.log("Message Delivery: PASSED");
    console.log("Audit Receipt: PASSED");
    console.log("Payload Hash: VERIFIED");
    console.log("Replay Protection: PASSED");
    console.log("================================");
    console.log("Total sent:", (await appA.sent()).toString());
    console.log("Total received:", (await appB.received()).toString());
  });
});
