// ChainProof two-node local deployment. Uses precompiled existing contracts.
// MockMailbox requires a same-chain remote mailbox; a source-side staging mailbox
// collects messages for an explicitly trusted off-chain demo relay.
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const base = path.resolve(__dirname, '..', '..', 'artifacts');
const app = require(path.join(base, 'contracts', 'HelloWorld.sol', 'HelloWorld.json'));
const mailbox = require(path.join(base, '@hyperlane-xyz', 'core', 'contracts', 'mock', 'MockMailbox.sol', 'MockMailbox.json'));
const gateArtifact = require(path.join(base, 'contracts', 'ChainProofValidatorGate.sol', 'ChainProofValidatorGate.json'));
const pA = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
const pB = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8546');
async function deploy(provider, artifact, ...args) {
  const signer = provider.getSigner(0);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  return contract;
}
async function main() {
  const [a, b] = await Promise.all([pA.getNetwork(),pB.getNetwork()]);
  if (a.chainId === b.chainId) throw Error('Two independent local networks need distinct chain IDs. Start B with provided config.');
  console.log('Source chain', a.chainId, 'Destination chain', b.chainId);
  const mailboxA = await deploy(pA, mailbox, 1000);
  const stagingB = await deploy(pA, mailbox, 2000);
  const mailboxB = await deploy(pB, mailbox, 2000);
  await (await mailboxA.addRemoteMailbox(2000, stagingB.address)).wait();
  const appA = await deploy(pA, app, mailboxA.address, await mailboxA.defaultHook());
  const appB = await deploy(pB, app, mailboxB.address, await mailboxB.defaultHook());
  await (await appA.enrollRemoteRouter(2000, ethers.utils.hexZeroPad(appB.address, 32))).wait();
  await (await appB.enrollRemoteRouter(1000, ethers.utils.hexZeroPad(appA.address, 32))).wait();
  const validatorAddresses = await Promise.all([2,3,4].map(i => pA.getSigner(i).getAddress()));
  const gate = await deploy(pB, gateArtifact, a.chainId, validatorAddresses, 2);
  await (await appB.setValidatorGate(gate.address)).wait();
  console.log("Receiver now enforces validator approval:", await appB.validatorGate());
  const output = { mode:'two-independent-local-networks-with-validator-gate', network:'Two independent local EVM networks', chainId:a.chainId, chainIdB:b.chainId, domainA:1000,domainB:2000, mailboxA:mailboxA.address, stagingB:stagingB.address,mailboxB:mailboxB.address,appA:appA.address,appB:appB.address, validatorGate:gate.address, validatorAddresses, validatorThreshold:2};
  fs.writeFileSync(path.join(__dirname, '..','deployment.json'),JSON.stringify(output,null,2));
  console.log('DEPLOYED',JSON.stringify(output,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
