// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "@hyperlane-xyz/core/contracts/client/Router.sol";

interface IChainProofValidatorGate {
    function getDigest(bytes32 messageHash, uint256 nonce) external view returns (bytes32);
    function approved(bytes32 digest) external view returns (bool);
}

/**
 * @title HelloWorld
 * @notice Existing Hyperlane HelloWorld application with destination-side
 * ChainProof attestation enforcement and message audit receipts.
 * @dev Demo security boundary: authorized validator accounts can attest,
 * but this contract does NOT independently verify origin chain finality.
 */
contract HelloWorld is Router {
    uint256 public constant HANDLE_GAS_AMOUNT = 50_000;
    uint256 public sent;
    uint256 public received;
    mapping(uint32 => uint256) public sentTo;
    mapping(uint32 => uint256) public receivedFrom;

    mapping(bytes32 => bool) public auditRecorded;
    uint256 public totalAuditReceipts;

    // Set on the destination application; zero means no gate (source app / old tests).
    address public validatorGate;
    event ValidatorGateConfigured(address indexed gate);
    event ChainProofReceipt(bytes32 indexed auditId, uint32 indexed origin, bytes32 indexed sender, bytes32 payloadHash);
    event SentHelloWorld(uint32 indexed origin, uint32 indexed destination, string message);
    event ReceivedHelloWorld(uint32 indexed origin, uint32 indexed destination, bytes32 sender, string message);
    event HandleGasAmountSet(uint32 indexed destination, uint256 handleGasAmount);

    constructor(address _mailbox, address _hook) Router(_mailbox) {
        _transferOwnership(msg.sender);
        setHook(_hook);
    }

    function setValidatorGate(address _gate) external onlyOwner {
        require(validatorGate == address(0), "ChainProof: gate already configured");
        require(_gate != address(0) && _gate.code.length > 0, "ChainProof: invalid gate");
        validatorGate = _gate;
        emit ValidatorGateConfigured(_gate);
    }

    function sendHelloWorld(uint32 _destinationDomain, string calldata _message) external payable {
        sent += 1;
        sentTo[_destinationDomain] += 1;
        _Router_dispatch(_destinationDomain, msg.value, bytes(_message));
        emit SentHelloWorld(mailbox.localDomain(), _destinationDomain, _message);
    }

    function quoteDispatch(uint32 _destinationDomain, bytes calldata _message) external view returns (uint256) {
        return _Router_quoteDispatch(_destinationDomain, _message);
    }

    function verifyAuditReceipt(bytes32 _auditId) external view returns (bool) {
        return auditRecorded[_auditId];
    }

    function _handle(uint32 _origin, bytes32 _sender, bytes calldata _message) internal override {
        bytes32 payloadHash = keccak256(_message);
        if (validatorGate != address(0)) {
            IChainProofValidatorGate gate = IChainProofValidatorGate(validatorGate);
            // received is the next delivery sequence index, starting at zero.
            bytes32 digest = gate.getDigest(payloadHash, received);
            require(gate.approved(digest), "ChainProof: validator approval required");
        }
        bytes32 auditId = keccak256(abi.encode(_origin, _sender, _message, received));
        auditRecorded[auditId] = true;
        totalAuditReceipts += 1;
        emit ChainProofReceipt(auditId, _origin, _sender, payloadHash);
        received += 1;
        receivedFrom[_origin] += 1;
        emit ReceivedHelloWorld(_origin, mailbox.localDomain(), _sender, string(_message));
    }
}
