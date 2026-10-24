import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import 'solidity-coverage';
module.exports = {
  solidity: { version: '0.8.22' },
  networks: { hardhat: { chainId: 31338 } },
  typechain: {outDir:'./src/types', target:'ethers-v5', alwaysGenerateOverloads:true,node16Modules:true,tsNocheck:true},
};
