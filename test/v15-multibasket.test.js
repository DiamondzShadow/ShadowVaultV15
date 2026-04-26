// ═══════════════════════════════════════════════════════════════════════
//  v15-multibasket.test.js — Pool A with real WETH / WBTC / USDC basket
//
//  Exercises the full keeper path:
//    1. User deposit → 70% idle USDC in vault, 30% to Aave
//    2. Keeper executeBuyBasket → USDC → WETH via MockSwapper
//    3. Keeper executeBuyBasket → USDC → WBTC via MockSwapper
//    4. getBasketDrift returns correct weights
//    5. Keeper executeRebalance → WETH ↔ WBTC (if drift detected)
//    6. requestWithdraw → Aave pulled, pending created
//    7. Keeper executeWithdrawalSwap → WETH → USDC, WBTC → USDC
//    8. completeWithdraw → user receives ≈ original deposit (minus 1.2% fee)
//
//  All swap prices are computed off-chain from live Chainlink feeds so the
//  vault's `minOut` bounds are honoured. MockSwapper is pre-funded with all
//  three tokens by impersonating the aWETH / aWBTC / aUSDC Aave contracts.
// ═══════════════════════════════════════════════════════════════════════

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const {
  addresses: A,
  fundUSDC,
  fundWETH,
  fundWBTC,
  deployStackNoBasket,
  usdcFor,
} = require("./helpers/setup");

const forking = Boolean(process.env.FORK_BLOCK);

(forking ? describe : describe.skip)("ShadowVaultV15 — multi-token basket (Arbitrum fork)", function () {
  this.timeout(300_000);

  const Tier = { FLEX: 0, THIRTY: 1, NINETY: 2, ONEIGHTY: 3, YEAR: 4 };
  const DEPOSIT = ethers.parseUnits("10000", 6); // $10,000

  // Pool A weights — must sum to 10,000 bps
  const W = { WETH: 4500, WBTC: 3500, USDC: 2000 }; // 45 / 35 / 20

  let stack;
  let admin, alice;
  let USDC, WETH, WBTC;
  let ethPrice, btcPrice; // 1e8 scale from Chainlink

  // MockSwapper.swap(tokenIn, tokenOut, amountIn, amountOut) selector
  const SWAP_ABI = ["function swap(address,address,uint256,uint256)"];
  const swapIface = new ethers.Interface(SWAP_ABI);

  function encodeSwap(tokenIn, tokenOut, amountIn, amountOut) {
    return swapIface.encodeFunctionData("swap", [tokenIn, tokenOut, amountIn, amountOut]);
  }

  /// Compute how much WETH you get for `usdcAmount` at the current ETH/USD price.
  /// ETH/USD feed is 8-dec, USDC is 6-dec, WETH is 18-dec.
  function usdcToWeth(usdcAmount) {
    // usdc [1e6] / ethPrice [1e8] * 1e18 = weth [1e18]
    // => usdc * 1e20 / ethPrice
    return (BigInt(usdcAmount) * 10n ** 20n) / BigInt(ethPrice);
  }
  function wethToUsdc(wethAmount) {
    // weth [1e18] * ethPrice [1e8] / 1e20 = usdc [1e6]
    return (BigInt(wethAmount) * BigInt(ethPrice)) / 10n ** 20n;
  }

  /// WBTC is 8-dec, BTC/USD feed is 8-dec.
  function usdcToWbtc(usdcAmount) {
    // usdc [1e6] * 1e10 / btcPrice [1e8] = wbtc [1e8]
    return (BigInt(usdcAmount) * 10n ** 10n) / BigInt(btcPrice);
  }
  function wbtcToUsdc(wbtcAmount) {
    // wbtc [1e8] * btcPrice [1e8] / 1e10 = usdc [1e6]
    return (BigInt(wbtcAmount) * BigInt(btcPrice)) / 10n ** 10n;
  }

  before(async function () {
    [admin, alice] = await ethers.getSigners();
    stack = await deployStackNoBasket(admin);
    USDC = await usdcFor(admin);
    WETH = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], A.WETH);
    WBTC = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], A.WBTC);

    // Read live Chainlink prices ONCE at setup to get realistic starting values.
    const feedAbi = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
    const ethFeed = await ethers.getContractAt(feedAbi, A.ETH_USD_FEED);
    const btcFeed = await ethers.getContractAt(feedAbi, A.BTC_USD_FEED);
    const [, ethAns] = await ethFeed.latestRoundData();
    const [, btcAns] = await btcFeed.latestRoundData();
    ethPrice = ethAns;
    btcPrice = btcAns;
    console.log(`    ETH/USD = $${Number(ethAns) / 1e8}`);
    console.log(`    BTC/USD = $${Number(btcAns) / 1e8}`);

    // Deploy MockPriceFeeds seeded with the live prices. These return
    // `updatedAt = block.timestamp` so the vault's 1-hour staleness check
    // passes even after we advance time in other test files.
    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed", admin);
    const mockEthFeed = await MockPriceFeed.deploy(ethPrice, 8);
    await mockEthFeed.waitForDeployment();
    const mockBtcFeed = await MockPriceFeed.deploy(btcPrice, 8);
    await mockBtcFeed.waitForDeployment();

    // Configure Pool A with the MOCK feeds (keeps real-market prices, fresh timestamps)
    await (await stack.vaultA.addBasketToken(A.WETH, W.WETH, await mockEthFeed.getAddress(), 8, 18, 0)).wait();
    await (await stack.vaultA.addBasketToken(A.WBTC, W.WBTC, await mockBtcFeed.getAddress(), 8, 8, 0)).wait();
    await (await stack.vaultA.addBasketToken(A.USDC, W.USDC, ethers.ZeroAddress, 0, 6, 0)).wait();

    // Fund MockSwapper with all three tokens at realistic sizes
    const mockAddr = await stack.mockSwapper.getAddress();
    await fundUSDC(mockAddr, ethers.parseUnits("500000", 6));   // $500k liquidity
    await fundWETH(mockAddr, ethers.parseUnits("200", 18));      // 200 WETH
    await fundWBTC(mockAddr, ethers.parseUnits("10", 8));        // 10 WBTC
  });

  it("deposit: 70% idle USDC in vault, 30% to Aave", async function () {
    await fundUSDC(alice.address, DEPOSIT);
    const usdcAlice = await usdcFor(alice);
    await (await usdcAlice.approve(await stack.vaultA.getAddress(), DEPOSIT)).wait();
    await (await stack.vaultA.connect(alice).deposit(DEPOSIT, Tier.FLEX)).wait();

    const vaultUsdc = await USDC.balanceOf(await stack.vaultA.getAddress());
    expect(vaultUsdc).to.equal(ethers.parseUnits("7000", 6));

    const adapterAssets = await stack.aaveAdapter.totalAssets();
    expect(adapterAssets).to.be.closeTo(ethers.parseUnits("3000", 6), ethers.parseUnits("0.01", 6));
  });

  it("executeBuyBasket: USDC → WETH at 45% weight", async function () {
    // 45% of $7000 = $3150 → WETH
    const usdcIn = ethers.parseUnits("3150", 6);
    const wethOut = usdcToWeth(usdcIn);
    // Apply a 0.25% MockSwapper slippage vs oracle to simulate real market
    const wethDelivered = (wethOut * 9975n) / 10000n;

    const calldata = encodeSwap(A.USDC, A.WETH, usdcIn, wethDelivered);
    // minOut: 0.5% tolerance (wider than MockSwapper's 0.25% bite)
    const minOut = (wethOut * 9950n) / 10000n;

    await (await stack.vaultA.connect(admin).executeBuyBasket(
      A.WETH, usdcIn, minOut, await stack.mockSwapper.getAddress(), calldata,
    )).wait();

    const vaultWeth = await WETH.balanceOf(await stack.vaultA.getAddress());
    expect(vaultWeth).to.equal(wethDelivered);
    const vaultUsdc = await USDC.balanceOf(await stack.vaultA.getAddress());
    expect(vaultUsdc).to.equal(ethers.parseUnits("3850", 6)); // 7000 - 3150
  });

  it("executeBuyBasket: USDC → WBTC at 35% weight", async function () {
    // 35% of $7000 = $2450 → WBTC
    const usdcIn = ethers.parseUnits("2450", 6);
    const wbtcOut = usdcToWbtc(usdcIn);
    const wbtcDelivered = (wbtcOut * 9975n) / 10000n;

    const calldata = encodeSwap(A.USDC, A.WBTC, usdcIn, wbtcDelivered);
    const minOut = (wbtcOut * 9950n) / 10000n;

    await (await stack.vaultA.connect(admin).executeBuyBasket(
      A.WBTC, usdcIn, minOut, await stack.mockSwapper.getAddress(), calldata,
    )).wait();

    const vaultWbtc = await WBTC.balanceOf(await stack.vaultA.getAddress());
    expect(vaultWbtc).to.equal(wbtcDelivered);
    const vaultUsdc = await USDC.balanceOf(await stack.vaultA.getAddress());
    expect(vaultUsdc).to.equal(ethers.parseUnits("1400", 6)); // 3850 - 2450
  });

  it("getBasketDrift: weights are close to target after keeper buys", async function () {
    const [tokens, currentBps, targetBps, driftBps] = await stack.vaultA.getBasketDrift();
    expect(tokens.length).to.equal(3);

    // Collect drift for each token
    const drift = {};
    for (let i = 0; i < tokens.length; i++) {
      const sym = tokens[i].toLowerCase();
      drift[sym] = {
        current: Number(currentBps[i]),
        target: Number(targetBps[i]),
        drift: Number(driftBps[i]),
      };
    }
    const weth = drift[A.WETH.toLowerCase()];
    const wbtc = drift[A.WBTC.toLowerCase()];
    const usdc = drift[A.USDC.toLowerCase()];

    // After the two buys with 0.25% MockSwapper slippage, weights should be
    // within ~75 bps of target.
    expect(Math.abs(weth.drift)).to.be.lte(100);
    expect(Math.abs(wbtc.drift)).to.be.lte(100);
    expect(Math.abs(usdc.drift)).to.be.lte(100);
  });

  it("executeRebalance: swap WETH → WBTC honours minOut from oracle", async function () {
    // Simulate needing to move $500 from WETH to WBTC
    const rebalUsdValue = 500n * 10n ** 6n;
    const wethIn = usdcToWeth(rebalUsdValue);
    const wbtcEquivalent = usdcToWbtc(rebalUsdValue);
    const wbtcDelivered = (wbtcEquivalent * 9975n) / 10000n;

    const calldata = encodeSwap(A.WETH, A.WBTC, wethIn, wbtcDelivered);
    const minOut = (wbtcEquivalent * 9950n) / 10000n;

    const wethBefore = await WETH.balanceOf(await stack.vaultA.getAddress());
    const wbtcBefore = await WBTC.balanceOf(await stack.vaultA.getAddress());

    await (await stack.vaultA.connect(admin).executeRebalance(
      A.WETH, A.WBTC, wethIn, minOut, await stack.mockSwapper.getAddress(), calldata,
    )).wait();

    const wethAfter = await WETH.balanceOf(await stack.vaultA.getAddress());
    const wbtcAfter = await WBTC.balanceOf(await stack.vaultA.getAddress());
    expect(wethBefore - wethAfter).to.equal(wethIn);
    expect(wbtcAfter - wbtcBefore).to.equal(wbtcDelivered);
  });

  it("executeRebalance: reverts when bought < minOut", async function () {
    const wethIn = usdcToWeth(100n * 10n ** 6n);
    // Make MockSwapper deliver WAY less than minOut expects
    const wbtcDelivered = 1n; // 1 wei
    const minOut = usdcToWbtc(100n * 10n ** 6n);

    const calldata = encodeSwap(A.WETH, A.WBTC, wethIn, wbtcDelivered);
    await expect(
      stack.vaultA.connect(admin).executeRebalance(
        A.WETH, A.WBTC, wethIn, minOut, await stack.mockSwapper.getAddress(), calldata,
      ),
    ).to.be.revertedWithCustomError(stack.vaultA, "SlippageExceeded");
  });

  it("executeRebalance: reverts when amount > maxRebalanceSize", async function () {
    // maxRebalanceSizeBps = 20% of basket value. Basket is ~$10k, so max ~$2k.
    // Try to rebalance $5k which should revert.
    const bigUsd = 5000n * 10n ** 6n;
    const wethIn = usdcToWeth(bigUsd);
    const wbtcOut = (usdcToWbtc(bigUsd) * 9975n) / 10000n;
    const calldata = encodeSwap(A.WETH, A.WBTC, wethIn, wbtcOut);

    await expect(
      stack.vaultA.connect(admin).executeRebalance(
        A.WETH, A.WBTC, wethIn, 0, await stack.mockSwapper.getAddress(), calldata,
      ),
    ).to.be.revertedWithCustomError(stack.vaultA, "RebalanceTooBig");
  });

  it("requestWithdraw + keeper sells basket + completeWithdraw", async function () {
    await hre.network.provider.send("evm_mine", []);

    // Snapshot vault basket holdings BEFORE request (request locks basket USDC pro-rata,
    // then keeper sells the rest back to USDC).
    const wethBalBefore = await WETH.balanceOf(await stack.vaultA.getAddress());
    const wbtcBalBefore = await WBTC.balanceOf(await stack.vaultA.getAddress());

    await (await stack.vaultA.connect(alice).requestWithdraw(1)).wait();

    // Keeper sells the entire WETH balance back to USDC
    const wethUsdOut = wethToUsdc(wethBalBefore);
    const wethUsdDelivered = (wethUsdOut * 9975n) / 10000n;
    const wethCalldata = encodeSwap(A.WETH, A.USDC, wethBalBefore, wethUsdDelivered);
    await (await stack.vaultA.connect(admin).executeWithdrawalSwap(
      1, A.WETH, wethBalBefore, (wethUsdOut * 9950n) / 10000n,
      await stack.mockSwapper.getAddress(), wethCalldata,
    )).wait();

    // Keeper sells the entire WBTC balance back to USDC
    const wbtcUsdOut = wbtcToUsdc(wbtcBalBefore);
    const wbtcUsdDelivered = (wbtcUsdOut * 9975n) / 10000n;
    const wbtcCalldata = encodeSwap(A.WBTC, A.USDC, wbtcBalBefore, wbtcUsdDelivered);
    await (await stack.vaultA.connect(admin).executeWithdrawalSwap(
      1, A.WBTC, wbtcBalBefore, (wbtcUsdOut * 9950n) / 10000n,
      await stack.mockSwapper.getAddress(), wbtcCalldata,
    )).wait();

    const aliceBefore = await USDC.balanceOf(alice.address);
    await (await stack.vaultA.connect(admin).completeWithdraw(1)).wait();
    const aliceAfter = await USDC.balanceOf(alice.address);
    const received = aliceAfter - aliceBefore;

    // $10,000 deposit minus 1.2% fee = $9,880. MockSwapper bites 0.25% per swap,
    // so we expect ≳ $9,800 back. Very little yield (minimal time passed).
    expect(received).to.be.gt(ethers.parseUnits("9700", 6));
    expect(received).to.be.lt(ethers.parseUnits("10100", 6));
  });
});
