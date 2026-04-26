const hre = require("hardhat");
async function main() {
  const [s] = await hre.ethers.getSigners();
  const ep = new hre.ethers.Contract("0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9", [
    "function setConfig(address oapp, address lib, tuple(uint32 eid, uint32 configType, bytes config)[] params) external",
    "function getConfig(address,address,uint32,uint32) view returns (bytes)",
  ], s);
  const sortAsc = (arr) => [...arr].sort((a,b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  const cfg = hre.ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint64,uint8,uint8,uint8,address[],address[])"],
    [[20n, 2, 2, 1,
      sortAsc(["0xc097ab8cd7b053326dfe9fb3e3a31a0cce3b526f","0x8e49ef1dfae17e547ca0e7526ffda81fbaca810a"]),
      sortAsc(["0xbb83ecf372cbb6daa629ea9a9a53bec6d601f229","0xf55e9daef79eec17f76e800f059495f198ef8348"])
    ]]);
  const tx = await ep.setConfig(
    "0xe04534850F5A562F63D3eFD24D8D1A143420235B",
    "0x7cacBe439EaD55fa1c22790330b12835c6884a91",
    [{ eid: 30110, configType: 2, config: cfg }]
  );
  console.log("restore tx:", tx.hash);
  await tx.wait();
  const after = await ep.getConfig("0xe04534850F5A562F63D3eFD24D8D1A143420235B","0x7cacBe439EaD55fa1c22790330b12835c6884a91",30110,2);
  console.log("post-restore config head:", after.slice(0,134) + "...");
}
main().catch(e=>{console.error(e);process.exit(1);});
