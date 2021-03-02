const ethers = require('ethers');
const { assert } = require('../contracts/common');
const { assertRevertOptimism } = require('./utils/revertOptimism');
const { connectContract } = require('./utils/connectContract');

const itCanPerformWithdrawalsTo = ({ ctx }) => {
	describe('[WITHDRAW TO] when migrating SNX from L2 to another account on L1', () => {
		const amountToWithdraw = ethers.utils.parseEther('100');

		let user1L2;

		let SynthetixL1, SynthetixBridgeToOptimismL1;
		let SynthetixL2, SynthetixBridgeToBaseL2, SystemStatusL2;

		const randomAddress = ethers.Wallet.createRandom().address;

		// --------------------------
		// Setup
		// --------------------------

		before('identify signers', async () => {
			user1L2 = new ethers.Wallet(ctx.user1PrivateKey, ctx.providerL2);
		});

		before('connect to contracts', async () => {
			// L1
			SynthetixL1 = connectContract({ contract: 'Synthetix', provider: ctx.providerL1 });
			SynthetixBridgeToOptimismL1 = connectContract({
				contract: 'SynthetixBridgeToOptimism',
				provider: ctx.providerL1,
			});

			// L2
			SynthetixL2 = connectContract({
				contract: 'Synthetix',
				source: 'MintableSynthetix',
				useOvm: true,
				provider: ctx.providerL2,
			});
			SynthetixBridgeToBaseL2 = connectContract({
				contract: 'SynthetixBridgeToBase',
				useOvm: true,
				provider: ctx.providerL2,
			});
			SystemStatusL2 = connectContract({
				contract: 'SystemStatus',
				useOvm: true,
				provider: ctx.providerL2,
			});
		});

		before('make a deposit', async () => {
			// Make a deposit so that
			// 1. There is SNX in the bridge for withdrawals,
			// 2. Counter a known bug in Optimism, where "now" is always 0 unless a message has been relayed

			SynthetixL1 = SynthetixL1.connect(ctx.ownerL1);
			await SynthetixL1.approve(
				SynthetixBridgeToOptimismL1.address,
				ethers.utils.parseEther(amountToWithdraw.toString())
			);

			SynthetixBridgeToOptimismL1 = SynthetixBridgeToOptimismL1.connect(ctx.ownerL1);
			await SynthetixBridgeToOptimismL1.deposit(amountToWithdraw);
		});

		// --------------------------
		// Get SNX
		// --------------------------

		describe('when a user has the expected amount of SNX in L2', () => {
			let user1BalanceL2;

			before('record current values', async () => {
				user1BalanceL2 = await SynthetixL2.balanceOf(user1L2.address);
			});

			before('ensure that the user has the expected SNX balance', async () => {
				SynthetixL2 = SynthetixL2.connect(ctx.ownerL2);

				const tx = await SynthetixL2.transfer(user1L2.address, amountToWithdraw);
				await tx.wait();
			});

			it('shows the user has SNX', async () => {
				assert.bnEqual(
					await SynthetixL2.balanceOf(user1L2.address),
					user1BalanceL2.add(amountToWithdraw)
				);
			});

			// --------------------------
			// At least one issuance
			// --------------------------

			describe('when the SNX rate has been updated', () => {
				// --------------------------
				// Suspended
				// --------------------------

				describe('when the system is suspended in L2', () => {
					before('suspend the system', async () => {
						SystemStatusL2 = SystemStatusL2.connect(ctx.ownerL2);

						await SystemStatusL2.suspendSystem(1);
					});

					after('resume the system', async () => {
						SystemStatusL2 = SystemStatusL2.connect(ctx.ownerL2);

						await SystemStatusL2.resumeSystem();
					});

					it('reverts when the user attempts to initiate a withdrawal', async () => {
						SynthetixBridgeToBaseL2 = SynthetixBridgeToBaseL2.connect(user1L2);

						const tx = await SynthetixBridgeToBaseL2.withdrawTo(randomAddress, 1);

						await assertRevertOptimism({
							tx,
							reason: 'Synthetix is suspended',
							provider: ctx.providerL2,
						});
					});
				});

				// --------------------------
				// Not suspended
				// --------------------------

				describe('when a user initiates a withdrawal on L2 to a another account on L1', () => {
					let user1BalanceL1;
					let withdrawalReceipt;
					let withdrawalFinalizedEvent;
					let randomAddressBalanceL1;

					const eventListener = (from, value, event) => {
						if (event && event.event === 'WithdrawalFinalized') {
							withdrawalFinalizedEvent = event;
						}
					};

					before('listen to events on l1', async () => {
						SynthetixBridgeToOptimismL1.on('WithdrawalFinalized', eventListener);
					});

					before('record current values', async () => {
						user1BalanceL1 = await SynthetixL1.balanceOf(user1L2.address);
						randomAddressBalanceL1 = await SynthetixL1.balanceOf(randomAddress);
						user1BalanceL2 = await SynthetixL2.balanceOf(user1L2.address);
					});

					before('initiate withdrawal', async () => {
						SynthetixBridgeToBaseL2 = SynthetixBridgeToBaseL2.connect(user1L2);

						const tx = await SynthetixBridgeToBaseL2.withdrawTo(randomAddress, amountToWithdraw);
						withdrawalReceipt = await tx.wait();
					});

					it('emitted a Withdrawal event', async () => {
						const event = withdrawalReceipt.events.find(e => e.event === 'WithdrawalInitiated');
						assert.exists(event);

						assert.equal(event.args.from, user1L2.address);
						assert.equal(event.args.to, randomAddress);
						assert.bnEqual(event.args.amount, amountToWithdraw);
					});

					it('reduces the users balance', async () => {
						assert.bnEqual(
							await SynthetixL2.balanceOf(user1L2.address),
							user1BalanceL2.sub(amountToWithdraw)
						);
					});

					describe('when waiting for the tx to complete on L1', () => {
						before('listen for completion', async () => {
							const [transactionHashL1] = await ctx.watcher.getMessageHashesFromL2Tx(
								withdrawalReceipt.transactionHash
							);
							await ctx.watcher.getL1TransactionReceipt(transactionHashL1);
						});

						before('stop listening to events on L1', async () => {
							SynthetixBridgeToOptimismL1.off('WithdrawalFinalized', eventListener);
						});

						it('emitted a WithdrawalFinalized event', async () => {
							assert.exists(withdrawalFinalizedEvent);
							assert.bnEqual(withdrawalFinalizedEvent.args.amount, amountToWithdraw);
							assert.equal(withdrawalFinalizedEvent.args.to, randomAddress);
						});

						it('shows that the randomAccount L1 balance increased', async () => {
							assert.bnEqual(await SynthetixL1.balanceOf(user1L2.address), user1BalanceL1);
							assert.bnEqual(
								await SynthetixL1.balanceOf(randomAddress),
								randomAddressBalanceL1.add(amountToWithdraw)
							);
						});
					});
				});
			});
		});
	});
};

module.exports = {
	itCanPerformWithdrawalsTo,
};
