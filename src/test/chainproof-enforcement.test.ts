import { expect } from "chai";
import hre from "hardhat";

describe("ChainProof v5 - destination enforced approvals", function () {
  it("rejects unapproved delivery and accepts the same message after 2 validator signatures", async function () {
    const signers = await hre.ethers.getSigners();
    const Mailbox = await hre.ethers.getContractFactory("MockMailbox");
    const source = await Mailbox.deploy(1000);
    await source.deployed();
    const destination = await Mailbox.deploy(2000);
    await destination.deployed();
    await (await source.addRemoteMailbox(2000, destination.address)).wait();

    const App = await hre.ethers.getContractFactory("HelloWorld");
    const appA = await App.deploy(source.address, await source.defaultHook());
    await appA.deployed();
    const appB = await App.deploy(destination.address, await destination.defaultHook());
    await appB.deployed();
    await (await appA.enrollRemoteRouter(2000, hre.ethers.utils.hexZeroPad(appB.address, 32))).wait();
    await (await appB.enrollRemoteRouter(1000, hre.ethers.utils.hexZeroPad(appA.address, 32))).wait();

    const Gate = await hre.ethers.getContractFactory("ChainProofValidatorGate");
    const localChainId = (await hre.ethers.provider.getNetwork()).chainId;
    const gate = await Gate.deploy(localChainId + 1, [signers[2].address, signers[3].address, signers[4].address], 2);
    await gate.deployed();
    await (await appB.setValidatorGate(gate.address)).wait();
    expect(await appB.validatorGate()).to.equal(gate.address);

    const message = "Destination verification is enforced";
    const bytes = hre.ethers.utils.toUtf8Bytes(message);
    const fee = await appA.quoteDispatch(2000, bytes);
    await (await appA.sendHelloWorld(2000, message, {value: fee})).wait();

    await expect(destination.processNextInboundMessage()).to.be.revertedWith("ChainProof: validator approval required");
    expect((await appB.received()).toString()).to.equal("0");
    expect((await appB.totalAuditReceipts()).toString()).to.equal("0");

    const hash = hre.ethers.utils.keccak256(bytes);
    const digest = await gate.getDigest(hash, 0);
    const one = await signers[2].signMessage(hre.ethers.utils.arrayify(digest));
    await expect(gate.verifyAndRecord(hash, 0, [one])).to.be.revertedWith("Gate: insufficient signatures");
    const two = await signers[3].signMessage(hre.ethers.utils.arrayify(digest));
    await (await gate.verifyAndRecord(hash, 0, [one, two])).wait();

    await (await destination.processNextInboundMessage()).wait();
    expect((await appB.received()).toString()).to.equal("1");
    expect((await appB.totalAuditReceipts()).toString()).to.equal("1");
    console.log("CHAINPROOF V5: unapproved delivery rejected; 2-signature approved delivery accepted");
  });
});
