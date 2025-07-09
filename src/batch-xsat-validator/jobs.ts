import { logger } from '../utils/logger';
import { getErrorMessage, sleep } from '../utils/common';
import { ContractName, ErrorCode } from '../utils/enumeration';
import {
  blockValidateTotalCounter,
  errorTotalCounter,
  validateLatestBlockGauge,
  validateLatestTimeGauge,
} from '../utils/prom';
import { BatchValidatorState } from './index';
import { getblockcount, getblockhash } from '../utils/bitcoin';
import BN from 'bn.js';
import ExsatApi from '../utils/exsat-api';

export class BatchValidatorJobs {
  constructor(public state: BatchValidatorState) {}

  // Check if the account is qualified to endorse by searching through the list of validators.
  isEndorserQualified(
    endorsers: { account: string; staking: number }[],
    accountName: string
  ): boolean {
    return endorsers.some((endorser) => endorser.account === accountName);
  }

  // Check whether an endorsement is needed and submit if necessary.
  async checkAndSubmit(
    exsatApi: ExsatApi,
    accountName: string,
    height: number,
    hash: string
  ): Promise<void> {
    const validatorInfo = await this.state.tableApi!.getValidatorInfo(accountName);
    // Use xsatScope if a role is defined; otherwise, use the block height directly.
    const scope = validatorInfo.role ? this.xsatScope(height) : height;
    const endorsement = await this.state.tableApi!.getEndorsementByBlockId(scope, hash);

    if (endorsement) {
      // If the account is already among the provider validators, skip further processing.
      if (this.isEndorserQualified(endorsement.provider_validators, accountName)) {
        return;
      }
      // If the account is a requested endorser or if the last consensus height is less than the current height, submit endorsement.
      const isQualifiedEndorser = this.isEndorserQualified(endorsement.requested_validators, accountName);
      if (isQualifiedEndorser || (validatorInfo.latest_consensus_block < height && validatorInfo.active_flag !== 0)) {
        await this.submit(exsatApi, accountName, height, hash);
        return;
      }
    } else if (validatorInfo.active_flag !== 0) {
      // No endorsement exists and the validator is active.
      await this.submit(exsatApi, accountName, height, hash);
      return;
    }

    logger.warn(
      `The current validator [${accountName}] does not meet the endorsement eligibility requirements. Please stake sufficient tokens first.`
    );
  }

  // Submit an endorsement to the blockchain.
  async submit(
    exsatApi: ExsatApi,
    validator: string,
    height: number,
    hash: string
  ): Promise<void> {
    try {
      const result: any = await exsatApi.executeAction(ContractName.blkendt, 'endorse', {
        validator,
        height,
        hash,
      });
      if (result && result.transaction_id) {
        blockValidateTotalCounter.inc({
          account: exsatApi.getAccountName(),
          client: this.state.client,
        });
        validateLatestBlockGauge.set({ account: exsatApi.getAccountName(), client: this.state.client }, height);
        validateLatestTimeGauge.set({ account: exsatApi.getAccountName(), client: this.state.client }, Date.now());
        logger.info(
          `Submit endorsement success, account: ${validator}, height: ${height}, hash: ${hash}, transaction_id: ${result.transaction_id}`
        );
      }
    } catch (error) {
      logger.error(`Failed to submit endorsement for ${validator} at height ${height}`, error);
      throw error; // Rethrow to allow the caller to handle it if necessary.
    }
  }

  // Endorse job: Verify startup status, obtain current block info, and process endorsements concurrently.
  endorse = async (): Promise<void> => {
    if (this.state.endorseRunning) return;
    this.state.endorseRunning = true;
    try {
      if (!this.state.startupStatus) {
        this.state.startupStatus = await this.state.tableApi!.getStartupStatus();
        if (!this.state.startupStatus) {
          logger.info('The exSat Network has not officially launched yet. Please wait for it to start');
          await sleep(30000);
          return;
        }
      }
      logger.info('Endorse task is running');

      const blockcountInfo = await getblockcount();
      const blockhashInfo = await getblockhash(blockcountInfo.result);
      const currentHeight = blockcountInfo.result;
      const currentHash = blockhashInfo.result;

      // Process all Exsat APIs concurrently.
      await Promise.all(
        this.state.exsatApis.map((exsatApi) =>
          this.checkAndSubmit(exsatApi, exsatApi.getAccountName(), currentHeight, currentHash)
        )
      );
    } catch (e) {
      const errorMessage = getErrorMessage(e);
      logger.info(`Endorse task info: ${errorMessage}`);
      // Define transient errors that require a delay.
      const transientErrors = [ErrorCode.Code1001, ErrorCode.Code1003, ErrorCode.Code1008];
      if (transientErrors.some((code) => errorMessage.startsWith(code))) {
        await sleep(10000);
      } else {
        logger.error('Endorse task error', e);
        errorTotalCounter.inc({
          account: 'batch xsat validator',
          client: this.state.client,
        });
      }
    } finally {
      logger.info('Endorse task is finished');
      this.state.endorseRunning = false;
    }
  };

  // Endorse check job: Validate endorsements for blocks from the irreversible height up to the current block.
  endorseCheck = async (): Promise<void> => {
    if (this.state.endorseCheckRunning) return;
    this.state.endorseCheckRunning = true;
    try {
      logger.info('Endorse check task is running');
      const chainstate = await this.state.tableApi!.getChainstate();
      const blockcount = await getblockcount();
      const startEndorseHeight = chainstate!.irreversible_height + 1;
      const currentBlock = blockcount.result;

      // Iterate through the blocks needing endorsement.
      for (let height = startEndorseHeight; height <= currentBlock; height++) {
        try {
          const blockhash = await getblockhash(height);
          const hash = blockhash.result;
          logger.info(`Check endorsement for block ${height}/${currentBlock}`);

          // Check endorsements concurrently for all Exsat API instances.
          await Promise.all(
            this.state.exsatApis.map((exsatApi) =>
              this.checkAndSubmit(exsatApi, exsatApi.getAccountName(), height, hash)
            )
          );
        } catch (e: any) {
          const errorMessage = getErrorMessage(e);
          logger.info(`Endorse check task, height: ${height}, error: ${errorMessage}`);
          if (errorMessage.startsWith(ErrorCode.Code1002)) {
            // Skip specific error code 1002.
          } else if (
            [ErrorCode.Code1001, ErrorCode.Code1003, ErrorCode.Code1004, ErrorCode.Code1008].some((code) =>
              errorMessage.startsWith(code)
            )
          ) {
            await sleep(10000);
            return; // Exit the loop on transient errors.
          } else {
            logger.error(`Submit endorsement failed at height: ${height}`, e);
            errorTotalCounter.inc({
              account: 'batch xsat validator',
              client: this.state.client,
            });
          }
        }
      }
    } catch (e) {
      logger.error('Endorse check task error', e);
      errorTotalCounter.inc({
        account: 'batch xsat validator',
        client: this.state.client,
      });
      await sleep(10000);
    } finally {
      logger.info('Endorse check task is finished.');
      this.state.endorseCheckRunning = false;
    }
  };

  // Calculate the xsat scope based on block height using a bitwise OR with a hexadecimal constant.
  xsatScope(height: number): number {
    return new BN(height).or(new BN('100000000', 16)).toNumber();
  }

  // Heartbeat: Send a heartbeat for each Exsat API concurrently.
  heartbeat = async (): Promise<void> => {
    await Promise.all(
      this.state.exsatApis.map((exsatApi) => exsatApi.heartbeat(this.state.client))
    );
  };
}
