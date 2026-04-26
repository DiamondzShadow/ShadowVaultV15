// Rewire Pool E HyperSkin(s) to the new RevenueRouterHC v2 + authorize them.
const hre = require("hardhat");
const path = require("node:path");

const NEW_ROUTER = "0xeECf14e46AAAC32d50DA4b3BaE475c4BbFE00664";
const SKIN_V1    = "0x4bAd7c7257016f0b94144775f53C5BdF97219ED0"; // retired
const SKIN_V2    = "0x5f90c2f0E9CE11A19d49A2E54d9df7759C7581ae"; // active
const TREASURY   = "0xA7A09aF8a58E248a33a7f43deC7f1983ba82921E"; // HyperEVM Safe

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`expected 999, got ${chainId}`);

  const router = await hre.ethers.getContractAt("RevenueRouterHC", NEW_ROUTER);
  const AUTH_ROLE = await router.AUTHORIZED_ROLE();

  for (const [label, skin] of [["v2 (active)", SKIN_V2], ["v1 (retired)", SKIN_V1]]) {
    console.log(`\nHyperSkin ${label}: ${skin}`);
    const h = await hre.ethers.getContractAt("HyperSkin", skin);

    // 1. Authorize the skin to call router.routeRevenue
    if (await router.hasRole(AUTH_ROLE, skin)) {
      console.log("  router already authorizes skin ✓");
    } else {
      const tx = await router.addAuthorized(skin);
      await tx.wait();
      console.log("  router.addAuthorized: tx", tx.hash);
    }

    // 2. Point skin at new router
    try {
      const current = await h.revenueRouter();
      if (current.toLowerCase() === NEW_ROUTER.toLowerCase()) {
        console.log("  skin already points at new router ✓");
      } else {
        const tx = await h.setFeeRoutes(TREASURY, NEW_ROUTER);
        await tx.wait();
        console.log(`  setFeeRoutes(${TREASURY}, ${NEW_ROUTER}): tx ${tx.hash}`);
      }
    } catch (e) {
      console.log("  setFeeRoutes failed:", (e.shortMessage||e.message).slice(0, 100));
    }
  }
}

main().catch(e=>{console.error(e);process.exit(1);});
