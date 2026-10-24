// ChainProof local-only server. No production key management or internet access required.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DEPLOY = path.join(ROOT, 'deployment.json');
const CONTRACTS = path.resolve(ROOT, '..', 'artifacts', 'contracts', 'HelloWorld.sol', 'HelloWorld.json');
const GATE_ARTIFACT = path.resolve(ROOT, '..', 'artifacts', 'contracts', 'ChainProofValidatorGate.sol', 'ChainProofValidatorGate.json');
const MAILBOX = path.resolve(ROOT, '..', 'artifacts', '@hyperlane-xyz', 'core', 'contracts', 'mock', 'MockMailbox.sol', 'MockMailbox.json');

if (!fs.existsSync(DEPLOY) || !fs.existsSync(CONTRACTS) || !fs.existsSync(MAILBOX) || !fs.existsSync(GATE_ARTIFACT)) {
  console.error('Missing deployment.json or compiled artifacts. Run Hardhat compile and scripts/deploy.cjs first.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(DEPLOY, 'utf8'));
const appAbi = JSON.parse(fs.readFileSync(CONTRACTS, 'utf8')).abi;
const gateAbi = JSON.parse(fs.readFileSync(GATE_ARTIFACT, 'utf8')).abi;
const mailboxAbi = JSON.parse(fs.readFileSync(MAILBOX, 'utf8')).abi;
const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
const destProvider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8546');
if (config.mode !== 'two-independent-local-networks-with-validator-gate') { throw new Error('Run scripts/deploy-dual.cjs to configure two separate local networks.'); }
const signer = provider.getSigner(0);
const appA = new ethers.Contract(config.appA, appAbi, signer);
const destSigner = destProvider.getSigner(0);
const appB = new ethers.Contract(config.appB, appAbi, destSigner);
const mailboxB = new ethers.Contract(config.mailboxB, mailboxAbi, destSigner);
const stagingB = new ethers.Contract(config.stagingB, mailboxAbi, signer);
const gate = new ethers.Contract(config.validatorGate, gateAbi, destSigner);
const validators = [2,3,4].map(i => provider.getSigner(i));
const attacker = destProvider.getSigner(1);
let busy = false;
const attempts = [];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'http://127.0.0.1:' + PORT });
  res.end(JSON.stringify(body));
}
function asText(value) { return value && value.toString ? value.toString() : String(value); }
function friendly(error) { return error.reason || error.error?.message || error.message || String(error); }

async function listReceipts() {
  const events = await appB.queryFilter(appB.filters.ChainProofReceipt(), 0, 'latest');
  const deliveries = await appB.queryFilter(appB.filters.ReceivedHelloWorld(), 0, 'latest');
  return events.slice(-40).reverse().map((ev) => {
    const received = deliveries.find((d) => d.transactionHash === ev.transactionHash);
    return {
      auditId: ev.args.auditId, payloadHash: ev.args.payloadHash,
      sender: ev.args.sender, origin: asText(ev.args.origin),
      destination: String(config.domainB),
      message: received ? received.args.message : null,
      txHash: ev.transactionHash, block: ev.blockNumber,
      status: 'Delivered',
    };
  });
}
async function status() {
  const [network, networkB, sent, received, audit, receipts, balance] = await Promise.all([
    provider.getNetwork(), destProvider.getNetwork(), appA.sent(), appB.received(), appB.totalAuditReceipts(),
    listReceipts(), signer.getBalance(),
  ]);
  if (Number(network.chainId) !== Number(config.chainId) || Number(networkB.chainId) !== Number(config.chainIdB)) throw new Error('Local chain IDs changed; restart both nodes and redeploy.');
  const code = await provider.getCode(config.appA);
  const codeB = await destProvider.getCode(config.appB);
  const gateCode = await destProvider.getCode(config.validatorGate);
  if (code === '0x' || codeB === '0x' || gateCode === '0x') throw new Error('Contracts not found. Hardhat restarted: redeploy with scripts/deploy.cjs.');
  return {
    online: true, network: config.network, chainId: network.chainId, chainIdB:networkB.chainId, relayModel:"Destination-enforced two-of-three approval; trusted local relay",
    domainA: config.domainA, domainB: config.domainB,
    appA: config.appA, appB: config.appB, gate:config.validatorGate, validatorThreshold:config.validatorThreshold,
    sent: asText(sent), received: asText(received), audits: asText(audit),
    balance: ethers.utils.formatEther(balance), receipts,
    attempts: attempts.slice(-12).reverse(),
  };
}
// Source-chain observation: match the exact staged bytes against an actual
// successful transaction receipt emitted by the configured source mailbox.
// This is RPC-based event verification, NOT a light client or finality proof.
async function verifySourceEvidence(txHash, encodedMessage) {
  if (!ethers.utils.isHexString(txHash, 32)) throw new Error('Invalid source transaction hash.');
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) throw new Error('Source transaction missing or reverted.');
  if (receipt.to?.toLowerCase() !== config.appA.toLowerCase()) {
    throw new Error('Source transaction did not call the configured source application.');
  }
  const currentBlock = await provider.getBlockNumber();
  if (currentBlock < receipt.blockNumber) throw new Error('Invalid source block height.');
  const sourceCode = await provider.getCode(config.mailboxA, receipt.blockNumber);
  if (sourceCode === '0x') throw new Error('Source mailbox not deployed at this block.');
  const dispatches = [];
  const dispatchIds = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.mailboxA.toLowerCase()) continue;
    let parsed;
    try { parsed = new ethers.utils.Interface(mailboxAbi).parseLog(log); }
    catch (_) { continue; }
    if (parsed.name === 'Dispatch') dispatches.push(parsed);
    if (parsed.name === 'DispatchId') dispatchIds.push(parsed);
  }
  const exact = dispatches.filter(e => {
    const eventMessage = e.args.message ?? e.args[3];
    const sender = e.args.sender ?? e.args[0];
    const destination = e.args.destination ?? e.args[1];
    const recipient = e.args.recipient ?? e.args[2];
    return String(eventMessage).toLowerCase() === encodedMessage.toLowerCase()
      && String(sender).toLowerCase() === config.appA.toLowerCase()
      && Number(destination.toString()) === Number(config.domainB)
      && String(recipient).toLowerCase() === ethers.utils.hexZeroPad(config.appB,32).toLowerCase();
  });
  if (exact.length !== 1) throw new Error('Source Dispatch event does not match the staged message.');
  const messageId = ethers.utils.keccak256(encodedMessage);
  if (!dispatchIds.some(e => String(e.args.messageId ?? e.args[0]).toLowerCase() === messageId.toLowerCase())) {
    throw new Error('Source DispatchId event does not match the message hash.');
  }
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error('Source receipt block hash mismatch.');
  }
  return {sourceTx:txHash,sourceBlock:receipt.blockNumber,sourceBlockHash:receipt.blockHash,
    messageId,confirmations:currentBlock-receipt.blockNumber+1,
    evidence:'Confirmed source RPC receipt; Dispatch and DispatchId events matched exact encoded message'};
}

async function handleSend(body) {
  const message = String(body.message || '').trim();
  if (!message || message.length > 240) throw new Error('Message must contain 1–240 characters.');
  const bytes = ethers.utils.toUtf8Bytes(message);
  const quote = await appA.quoteDispatch(config.domainB, bytes);
  const nextIndex = await stagingB.inboundUnprocessedNonce();
  const sentTx = await appA.sendHelloWorld(config.domainB, message, { value: quote });
  const sentReceipt = await sentTx.wait();
  const sourceMessage = await stagingB.inboundMessages(nextIndex);
  if (sourceMessage === '0x') throw new Error('Source staging mailbox did not receive a message.');
  // Verify the actual source transaction receipt BEFORE requesting signatures.
  const sourceEvidence = await verifySourceEvidence(sentReceipt.transactionHash, sourceMessage);
  // Local validator accounts independently sign the source mailbox's encoded message hash.
  // Threshold approval is verified and recorded ON destination chain before our trusted relay.
  // The receiver enforces the exact message payload hash at its next received nonce.
  // Approval is no longer just a backend check: HelloWorld._handle checks it on-chain.
  const payloadHash = ethers.utils.keccak256(bytes);
  const destNonce = Number((await appB.received()).toString());
  const digest = await gate.getDigest(payloadHash, destNonce);
  const attestations = await Promise.all(validators.slice(0,2).map(v => v.signMessage(ethers.utils.arrayify(digest))));
  const approvedTx = await gate.verifyAndRecord(payloadHash, destNonce, attestations);
  const approvedReceipt = await approvedTx.wait();
  if (!(await gate.approved(digest))) throw new Error('Validator gate failed to persist approval.');
  // Explicitly trusted local relay: copy the original encoded message across RPC endpoints.
  const relayTx = await mailboxB.addInboundMessage(sourceMessage);
  await relayTx.wait();
  const processedTx = await mailboxB.processNextInboundMessage();
  const processedReceipt = await processedTx.wait();
  const events = await appB.queryFilter(appB.filters.ChainProofReceipt(), processedReceipt.blockNumber, processedReceipt.blockNumber);
  const auditEvent = events.find((e) => e.transactionHash === processedReceipt.transactionHash);
  if (!auditEvent) throw new Error('Delivery completed but no ChainProof audit receipt event was found.');
  return {
    ok: true, message,
    dispatchTx: sentReceipt.transactionHash, deliveryTx: processedReceipt.transactionHash, relayTx: relayTx.hash,
    auditId: auditEvent.args.auditId, payloadHash: auditEvent.args.payloadHash,
    attestationDigest:digest, attestationTx:approvedReceipt.transactionHash, validatorCount:2, sourceEvidence,
    feeWei: quote.toString(), block: processedReceipt.blockNumber,
  };
}
async function handleReplay() {
  const count = await appB.received();
  if (count.isZero()) throw new Error('Send a message before testing replay protection.');
  // The first inbound message has index 0; it is already processed.
  const before = (await appB.totalAuditReceipts()).toString();
  try {
    const tx = await mailboxB.processInboundMessage(0);
    await tx.wait();
    attempts.push({ type: 'Replay', result: 'Unexpected acceptance', at: new Date().toISOString() });
    throw new Error('SECURITY ISSUE: duplicate message was accepted.');
  } catch (error) {
    const reason = friendly(error);
    if (reason.includes('SECURITY ISSUE')) throw error;
    if (!reason.includes('already delivered')) throw error;
    const after = (await appB.totalAuditReceipts()).toString();
    if (after !== before) throw new Error('Audit count changed during rejected replay.');
    const result = { type: 'Replay', result: 'Rejected', reason: 'Mailbox: already delivered', at: new Date().toISOString() };
    attempts.push(result);
    return { ok: true, ...result };
  }
}

// Test a real contract-level authorization rejection. A different local account
// tries to call the destination app without going through its trusted mailbox.
async function handleUnauthorized() {
  const before = (await appB.totalAuditReceipts()).toString();
  const attackerAddress = await attacker.getAddress();
  const fakeSender = ethers.utils.hexZeroPad(attackerAddress, 32);
  const payload = ethers.utils.toUtf8Bytes('Forged interchain verification');

  // A static EVM call enforces the same Solidity access control, but does not
  // broadcast a transaction or consume gas. We can inspect the revert reliably.
  let reverted = false;
  let rejection = '';
  try {
    await appB.connect(attacker).callStatic.handle(config.domainA, fakeSender, payload);
  } catch (error) {
    reverted = true;
    const messages = [
      error.reason,
      error.error?.reason,
      error.error?.message,
      error.message,
      error.data?.message,
      error.error?.data?.message,
    ].filter((value) => typeof value === 'string');

    // Some JSON-RPC providers return ABI-encoded Error(string) rather than
    // exposing the decoded revert reason directly.
    const revertData = [error.data, error.error?.data?.data, error.error?.data]
      .find((value) => typeof value === 'string' && /^0x08c379a0[0-9a-f]*$/i.test(value));
    if (revertData) {
      try {
        const [decoded] = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + revertData.slice(10));
        messages.push(decoded);
      } catch (_) { /* retain provider-provided message */ }
    }

    rejection = messages.find((message) => message.includes('MailboxClient: sender not mailbox')) || '';
    if (!rejection) {
      throw new Error('Unauthorized test reverted, but the expected mailbox authorization reason could not be confirmed: ' + friendly(error));
    }
  }

  if (!reverted) throw new Error('SECURITY ISSUE: direct non-mailbox call was accepted.');
  const after = (await appB.totalAuditReceipts()).toString();
  if (before !== after) throw new Error('SECURITY ISSUE: audit state changed during the unauthorized test.');

  const result = {
    type: 'Unauthorized caller',
    result: 'Rejected',
    reason: 'MailboxClient: sender not mailbox',
    method: 'EVM callStatic (no transaction broadcast)',
    at: new Date().toISOString(),
  };
  attempts.push(result);
  return { ok: true, ...result };
}

// Compare caller-supplied content against the event hash stored on-chain.
// This is an integrity check, NOT proof that an altered transaction was submitted.
async function handleIntegrity(body) {
  const auditId = String(body.auditId || '').trim();
  const candidate = body.message;
  if (!ethers.utils.isHexString(auditId, 32)) throw new Error('Select a valid audit receipt first.');
  if (typeof candidate !== 'string' || candidate.length > 300) throw new Error('Message must be text up to 300 characters.');
  const events = await appB.queryFilter(appB.filters.ChainProofReceipt(auditId), 0, 'latest');
  if (events.length !== 1) throw new Error('Expected exactly one on-chain receipt with this audit ID.');
  const event = events[0];
  const recorded = event.args.payloadHash;
  const calculated = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(candidate));
  const match = recorded.toLowerCase() === calculated.toLowerCase();
  return {ok: true, match, auditId, recordedHash: recorded, calculatedHash: calculated,
    outcome: match ? 'Content matches the on-chain audit hash' : 'Content differs from the on-chain audit hash',
    note: 'Read-only comparison. This does not submit an altered transaction.'};
}

// Negative security test: insufficient signatures and altered message hash are
// rejected by the destination validator gate without changing chain state.
async function handleValidatorTest() {
  const sent = await appA.sent();
  if (sent.isZero()) throw new Error('Send at least one message before checking validator rejection.');
  const nextDelivery = Number((await appB.received()).toString());
  const testNonce = nextDelivery + 1000000;
  const messageHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('ChainProof signature test'));
  const wrongHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('ALTERED MESSAGE'));
  const digest = await gate.getDigest(messageHash, testNonce);
  const oneSignature = await validators[0].signMessage(ethers.utils.arrayify(digest));
  let insufficientRejected = false;
  try { await gate.callStatic.verifyAndRecord(messageHash, testNonce, [oneSignature]); }
  catch (error) { insufficientRejected = friendly(error).includes('insufficient signatures'); }
  if (!insufficientRejected) throw new Error('Insufficient-signature rejection was not confirmed.');
  const both = await Promise.all(validators.slice(0,2).map(v => v.signMessage(ethers.utils.arrayify(digest))));
  let tamperRejected = false;
  try { await gate.callStatic.verifyAndRecord(wrongHash, testNonce, both); }
  catch (error) { tamperRejected = friendly(error).includes('unauthorized signature'); }
  if (!tamperRejected) throw new Error('Altered-hash signature rejection was not confirmed.');
  const entry = {type:'Validator threshold',result:'Rejected',reason:'One signature insufficient; altered message signatures invalid',at:new Date().toISOString()};
  attempts.push(entry);
  return {ok:true,...entry,note:'Destination contract enforces approval for actual message delivery.'};
}

// Negative test of source evidence verification; no new transaction sent.
async function handleSourceEvidenceTest() {
  const recent = await appA.queryFilter(appA.filters.SentHelloWorld(), 0, 'latest');
  if (!recent.length) throw new Error('Send a message before testing source evidence tampering.');
  const txHash = recent[recent.length-1].transactionHash;
  const receipt = await provider.getTransactionReceipt(txHash);
  const logs = receipt.logs.filter(l => l.address.toLowerCase() === config.mailboxA.toLowerCase());
  const iface = new ethers.utils.Interface(mailboxAbi);
  const dispatch = logs.map(l => {try {return iface.parseLog(l);} catch (_) {return null;}})
    .find(l => l?.name === 'Dispatch');
  if (!dispatch) throw new Error('Unable to locate source Dispatch event.');
  const original = dispatch.args.message ?? dispatch.args[3];
  const altered = ethers.utils.hexlify(ethers.utils.concat([ethers.utils.arrayify(original),[0x01]]));
  let rejected = false;
  try { await verifySourceEvidence(txHash, altered); }
  catch (e) { rejected = e.message.includes('does not match the staged message'); }
  if (!rejected) throw new Error('SECURITY FAILURE: altered source bytes were not rejected.');
  const originalEvidence = await verifySourceEvidence(txHash, original);
  const result = {type:'Source evidence integrity',result:'Rejected',
    reason:'Altered encoded message did not match the source-chain Dispatch event',
    sourceTx:txHash,sourceBlock:originalEvidence.sourceBlock,
    at:new Date().toISOString()};
  attempts.push(result);
  return {ok:true,...result};
}

function serveStatic(req, res) {
  const route = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  const files = { '/':'index.html', '/index.html':'index.html', '/style.css':'style.css', '/app.js':'app.js' };
  const file = files[route];
  if (!file) return json(res, 404, { error: 'Not found' });
  const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] + '; charset=utf-8', 'Cache-Control':'no-store' });
  fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
}
const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  if (req.method === 'GET' && route === '/api/status') {
    try { return json(res, 200, await status()); }
    catch (error) { return json(res, 503, { error: friendly(error) }); }
  }
  if (req.method === 'POST' && (route === '/api/send' || route === '/api/replay' || route === '/api/unauthorized' || route === '/api/integrity' || route === '/api/validator-test' || route === '/api/source-evidence-test')) {
    if (busy) return json(res, 409, { error: 'A transaction is currently being processed.' });
    busy = true;
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 6000) throw new Error('Request body too large.');
      }
      const body = JSON.parse(raw || '{}');
      const result = route === '/api/send' ? await handleSend(body) : route === '/api/replay' ? await handleReplay() : route === '/api/unauthorized' ? await handleUnauthorized() : route === '/api/validator-test' ? await handleValidatorTest() : route === '/api/source-evidence-test' ? await handleSourceEvidenceTest() : await handleIntegrity(body);
      return json(res, 200, result);
    } catch (error) { return json(res, 400, { error: friendly(error) }); }
    finally { busy = false; }
  }
  if (req.method === 'GET') return serveStatic(req, res);
  return json(res, 405, { error:'Method not allowed' });
});
server.listen(PORT, HOST, () => console.log(`ChainProof explorer at http://${HOST}:${PORT}`));
