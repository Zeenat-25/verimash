import { expect } from "chai";
import hre from "hardhat";

describe("ChainProof v7 - adversarial security tests", function () {
  let signers: any[];
  let source: any;
  let destination: any;
  let appA: any;
  let appB: any;
  let gate: any;
  const domainA = 1000;
  const domainB = 2000;

  beforeEach(async function () {
    signers = await hre.ethers.getSigners();
    const Mailbox = await hre.ethers.getContractFactory("MockMailbox");
    source = await Mailbox.deploy(domainA);
    await source.deployed();
    destination = await Mailbox.deploy(domainB);
    await destination.deployed();
    await (await source.addRemoteMailbox(domainB, destination.address)).wait();

    const App = await hre.ethers.getContractFactory("HelloWorld");
    appA = await App.deploy(source.address, await source.defaultHook());
    await appA.deployed();
    appB = await App.deploy(destination.address, await destination.defaultHook());
    await appB.deployed();
    await (await appA.enrollRemoteRouter(domainB, hre.ethers.utils.hexZeroPad(appB.address, 32))).wait();
    await (await appB.enrollRemoteRouter(domainA, hre.ethers.utils.hexZeroPad(appA.address, 32))).wait();

    const Gate = await hre.ethers.getContractFactory("ChainProofValidatorGate");
    const localChainId = (await hre.ethers.provider.getNetwork()).chainId;
    gate = await Gate.deploy(localChainId + 1, [signers[2].address, signers[3].address, signers[4].address], 2);
    await gate.deployed();
    await (await appB.setValidatorGate(gate.address)).wait();
  });

  async function dispatch(message: string) {
    const payload = hre.ethers.utils.toUtf8Bytes(message);
    const fee = await appA.quoteDispatch(domainB, payload);
    const tx = await appA.sendHelloWorld(domainB, message, { value: fee });
    const receipt = await tx.wait();
    return { payload, receipt };
  }

  async function signatures(message: string, nonce: number, indexes = [2, 3]) {
    const hash = hre.ethers.utils.keccak256(hre.ethers.utils.toUtf8Bytes(message));
    const digest = await gate.getDigest(hash, nonce);
    const signed = await Promise.all(indexes.map(async (i) => signers[i].signMessage(hre.ethers.utils.arrayify(digest))));
    return { hash, digest, signed };
  }

  async function expectNoReceipts() {
    expect((await appB.received()).toString()).to.equal("0");
    expect((await appB.totalAuditReceipts()).toString()).to.equal("0");
  }

  it("1. rejects a delivered source message without approval", async function () {
    await dispatch("No validator approval");
    await expect(destination.processNextInboundMessage()).to.be.revertedWith("ChainProof: validator approval required");
    await expectNoReceipts();
  });

  it("2. rejects one validator signature", async function () {
    const proof = await signatures("Only one validator", 0, [2]);
    await expect(gate.verifyAndRecord(proof.hash, 0, proof.signed)).to.be.revertedWith("Gate: insufficient signatures");
    expect(await gate.approved(proof.digest)).to.equal(false);
    await expectNoReceipts();
  });

  it("3. rejects a forged signature from an unauthorized account", async function () {
    const proof = await signatures("Fake validator", 0, [2, 6]);
    await expect(gate.verifyAndRecord(proof.hash, 0, proof.signed)).to.be.revertedWith("Gate: unauthorized signature");
    expect(await gate.approved(proof.digest)).to.equal(false);
    await expectNoReceipts();
  });

  it("4. rejects duplicate signatures from the same validator", async function () {
    const proof = await signatures("Duplicated signer", 0, [2]);
    await expect(gate.verifyAndRecord(proof.hash, 0, [proof.signed[0], proof.signed[0]])).to.be.revertedWith("Gate: duplicate validator");
    await expectNoReceipts();
  });

  it("5. rejects a changed payload signed for different content", async function () {
    const message = "Real source message";
    await dispatch(message);
    const wrong = await signatures("Attacker changed the payload", 0);
    await (await gate.verifyAndRecord(wrong.hash, 0, wrong.signed)).wait();
    await expect(destination.processNextInboundMessage()).to.be.revertedWith("ChainProof: validator approval required");
    await expectNoReceipts();
  });

  it("6. rejects unauthorized direct handle invocation", async function () {
    const fake = hre.ethers.utils.hexZeroPad(signers[6].address, 32);
    await expect(appB.connect(signers[6]).handle(domainA, fake, hre.ethers.utils.toUtf8Bytes("Forged delivery")))
      .to.be.revertedWith("MailboxClient: sender not mailbox");
    await expectNoReceipts();
  });

  it("7. accepts authorized delivery once and rejects replay and duplicate approval", async function () {
    const message = "Unique verified message";
    await dispatch(message);
    const proof = await signatures(message, 0);
    await (await gate.verifyAndRecord(proof.hash, 0, proof.signed)).wait();
    await (await destination.processNextInboundMessage()).wait();
    expect((await appB.received()).toString()).to.equal("1");
    expect((await appB.totalAuditReceipts()).toString()).to.equal("1");
    await expect(destination.processInboundMessage(0)).to.be.revertedWith("Mailbox: already delivered");
    await expect(gate.verifyAndRecord(proof.hash, 0, proof.signed)).to.be.revertedWith("Gate: already approved");
    expect((await appB.totalAuditReceipts()).toString()).to.equal("1");
  });

  it("8. matches real source Dispatch evidence and detects modified encoded bytes", async function () {
    const { receipt } = await dispatch("Observe genuine source Dispatch");
    const iface = source.interface;
    const parsed = receipt.logs
      .filter((log: any) => log.address.toLowerCase() === source.address.toLowerCase())
      .map((log: any) => { try { return iface.parseLog(log); } catch { return null; } })
      .filter(Boolean);
    const event = parsed.find((item: any) => item.name === "Dispatch");
    const idEvent = parsed.find((item: any) => item.name === "DispatchId");
    expect(event, "Dispatch event should exist in source receipt").to.not.equal(undefined);
    expect(idEvent, "DispatchId event should exist in source receipt").to.not.equal(undefined);
    const encoded = event.args.message ?? event.args[3];
    const sourceId = hre.ethers.utils.keccak256(encoded);
    expect((idEvent.args.messageId ?? idEvent.args[0]).toLowerCase()).to.equal(sourceId.toLowerCase());
    const staged = await destination.inboundMessages(0);
    expect(staged.toLowerCase()).to.equal(encoded.toLowerCase());
    const changed = hre.ethers.utils.hexlify(hre.ethers.utils.concat([hre.ethers.utils.arrayify(encoded), [1]]));
    expect(changed.toLowerCase()).to.not.equal(encoded.toLowerCase());
    expect(hre.ethers.utils.keccak256(changed)).to.not.equal(sourceId);
    await expectNoReceipts();
  });
});
