const hre = require("hardhat");
const { ethers } = hre;
async function main() {
  const router = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const code = await ethers.provider.getCode(router);
  console.log("SwapRouter V1 code length:", code.length);
  const router2 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
  const code2 = await ethers.provider.getCode(router2);
  console.log("SwapRouter02 code length:", code2.length);
  const factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
  const factoryAbi = ["function getPool(address,address,uint24) view returns (address)"];
  const f = await ethers.getContractAt(factoryAbi, factory);
  const WEETH = "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe";
  const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
  const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await f.getPool(WEETH, WETH, fee);
    console.log(`weETH/WETH fee=${fee}: ${pool}`);
  }
  for (const fee of [100, 500, 3000]) {
    const pool = await f.getPool(WETH, USDC, fee);
    console.log(`WETH/USDC fee=${fee}: ${pool}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
