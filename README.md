# VeriMash

Cross-Chain Transaction Verification Infrastructure

VeriMash is a proof-of-concept application demonstrating secure cross-chain message verification between two EVM-compatible blockchain networks.

## Features

- Cross-chain message dispatch and delivery
- Source transaction and event verification
- 2-of-3 validator signature approval
- Destination smart-contract enforcement
- Replay and tampering detection
- Cryptographic audit receipts
- Live Alice-to-Bob transaction demonstration
- Transaction Explorer and Security Lab

## Architecture

1. Blockchain A dispatches a message.
2. VeriMash checks source transaction evidence.
3. Authorized validators provide threshold approval.
4. The destination contract enforces approval.
5. Blockchain B records successful message delivery.
6. The interface displays the verification evidence.

## Technology

- Solidity
- Hardhat
- Ethereum-compatible local networks
- Ethers.js
- Node.js
- HTML, CSS and JavaScript

## Current Status

Working local proof of concept.

The demo uses two local Hardhat blockchain networks, a mock cross-chain messaging environment, locally controlled validators and a trusted RPC/relay workflow.

The current implementation transfers verified messages, not cryptocurrency or tokens. It is not a production-ready trustless bridge.

## Running Locally

The current development version uses dependencies from its original monorepo workspace. This exported repository is a source snapshot and is not yet a standalone installable package.

Standalone setup instructions and hosted demo deployment will be added in a subsequent release.

## Security Testing

The project includes tests for validator enforcement, replay protection, unauthorized access and message tampering.
