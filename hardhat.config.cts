
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import 'solidity-coverage';

/**
 * VeriMash Hardhat configuration
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: '0.8.22',
  },

  paths: {
    sources: './contracts',
    tests: './src/test',
    cache: './cache',
    artifacts: './artifacts',
  },

  gasReporter: {
    currency: 'USD',
  },

  typechain: {
    outDir: './src/types',
    target: 'ethers-v5',
    alwaysGenerateOverloads: true,
    node16Modules: true,
    tsNocheck: true,
  },
};
