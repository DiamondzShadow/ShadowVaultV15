// Verify BonusAccumulatorV2_1 forgives orphan deregisters by
// eth_call-ing deregisterPosition on behalf of the actual pool vault
// (using `from` override). If it returns without reverting, the
// withdraw-path migration gap is closed.

const { ethers } = require("hardhat");

const V2_1 = "0x73c793E669e393aB02ABc12BccD16eF188514026";
const POOL_B = "0x0D32FA2788Ee6D19ae6ccc5BDB657C7321Ce8C90"; // orphan posId=1
const POOL_C = "0x2Ddd79fFdE4d382A40267E5D533F761d86365D64"; // orphan posId=2
const POOL_A = "0x3EABca4E9F1dA0CA6b61a3CC942c09Dd51D77E32"; // sanity: A has posId=2 in V2 but we re-wired to V2.1 so A's posId=2 is now also invisible to V2.1 state-wise

async function main() {
  const iface = new ethers.Interface([
    "function deregisterPosition(uint256 tokenId) external",
    "function positionWeight(address,uint256) view returns (uint256)",
  ]);

  const provider = ethers.provider;

  const cases = [
    { label: "Pool B posId=1 (v1 orphan)", from: POOL_B, tokenId: 1 },
    { label: "Pool C posId=2 (v1 orphan)", from: POOL_C, tokenId: 2 },
    { label: "Pool A posId=2 (was on old V2, now orphan on V2.1)", from: POOL_A, tokenId: 2 },
  ];

  for (const c of cases) {
    console.log(`\n── ${c.label} ──`);

    // Check V2.1 state
    const weightCall = iface.encodeFunctionData("positionWeight", [c.from, c.tokenId]);
    const weightRaw = await provider.call({ to: V2_1, data: weightCall });
    const [weight] = iface.decodeFunctionResult("positionWeight", weightRaw);
    console.log(`  V2.1 positionWeight[${c.from.slice(0,10)}...][${c.tokenId}] = ${weight}`);

    // Simulate deregisterPosition from the vault's address
    const data = iface.encodeFunctionData("deregisterPosition", [c.tokenId]);
    try {
      const ret = await provider.call({
        to: V2_1,
        data,
        from: c.from,
      });
      console.log(`  ✓ deregisterPosition(${c.tokenId}) did NOT revert — return: ${ret || "0x"}`);
    } catch (e) {
      const msg = e.message || String(e);
      console.error(`  ✗ REVERT: ${msg.slice(0, 300)}`);
      process.exit(1);
    }
  }

  console.log("\nall orphan deregister calls simulate cleanly. withdraw path is safe.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
