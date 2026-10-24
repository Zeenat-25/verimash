// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

/**
 * @title ChainProofValidatorGate
 * @notice Demonstration threshold-attestation contract for two local networks.
 * @dev Validators attest to a message hash; this contract does not prove source
 * chain finality or authenticate validator observations by itself.
 */
contract ChainProofValidatorGate {
    uint256 private constant SECP256K1_N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 public immutable sourceChainId;
    uint256 public immutable threshold;
    mapping(address => bool) public isValidator;
    mapping(bytes32 => bool) public approved;

    event AttestationApproved(bytes32 indexed digest, bytes32 indexed messageHash, uint256 nonce, uint256 signerCount);

    constructor(uint256 _sourceChainId, address[] memory _validators, uint256 _threshold) {
        require(_sourceChainId != block.chainid, "Gate: distinct chains required");
        require(_threshold > 0 && _threshold <= _validators.length, "Gate: invalid threshold");
        sourceChainId = _sourceChainId;
        threshold = _threshold;
        for (uint256 i = 0; i < _validators.length; i++) {
            address validator = _validators[i];
            require(validator != address(0) && !isValidator[validator], "Gate: invalid validator");
            isValidator[validator] = true;
        }
    }

    function getDigest(bytes32 messageHash, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("CHAINPROOF_LOCAL_ATTESTATION_V1"),
            sourceChainId,
            block.chainid,
            address(this),
            messageHash,
            nonce
        ));
    }

    function verifyAndRecord(bytes32 messageHash, uint256 nonce, bytes[] calldata signatures) external {
        bytes32 digest = getDigest(messageHash, nonce);
        require(!approved[digest], "Gate: already approved");
        require(signatures.length >= threshold, "Gate: insufficient signatures");
        bytes32 signedDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address[] memory used = new address[](signatures.length);
        uint256 matches = 0;
        for (uint256 i = 0; i < signatures.length; i++) {
            bytes calldata signature = signatures[i];
            require(signature.length == 65, "Gate: invalid signature length");
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 32))
                v := byte(0, calldataload(add(signature.offset, 64)))
            }
            require(uint256(s) <= SECP256K1_N_HALF && uint256(s) > 0, "Gate: noncanonical signature");
            require(v == 27 || v == 28, "Gate: invalid recovery id");
            address recovered = ecrecover(signedDigest, v, r, s);
            require(isValidator[recovered], "Gate: unauthorized signature");
            for (uint256 j = 0; j < i; j++) {
                require(used[j] != recovered, "Gate: duplicate validator");
            }
            used[i] = recovered;
            matches++;
        }
        require(matches >= threshold, "Gate: threshold not met");
        approved[digest] = true;
        emit AttestationApproved(digest, messageHash, nonce, matches);
    }
}
