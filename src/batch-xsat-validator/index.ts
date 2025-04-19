import cron from 'node-cron';
import { configureLogger, logger } from '../utils/logger';
import { batchValidatorEnvCheck, loadNetworkConfigurations } from '../utils/common';
import ExsatApi from '../utils/exsat-api';
import TableApi from '../utils/table-api';
import { Client, RoleType } from '../utils/enumeration';
import { errorTotalCounter, setupPrometheus, startTimeGauge } from '../utils/prom';
import { BatchValidatorJobs } from './jobs';
import { 
  HEARTBEAT_JOBS, 
  VALIDATOR_JOBS_ENDORSE, 
  VALIDATOR_JOBS_ENDORSE_CHECK, 
  VALIDATOR_KEYSTORE_DIR, 
  VALIDATOR_KEYSTORE_DIR_PASSWORD 
} from '../utils/config';
import fs from 'fs/promises';
import { getAccountInfo } from '../utils/keystore';
import path from 'path';

export class BatchValidatorState {
  exsatApis: ExsatApi[] = [];
  tableApi: TableApi | null = null;
  client: Client;
  startupStatus: boolean = false;
  endorseRunning: boolean = false;
  endorseCheckRunning: boolean = false;
}

/**
 * Initializes all Exsat APIs concurrently and retrieves the table API.
 */
export async function setupApis(accountInfos: any[]): Promise<{
  exsatApis: ExsatApi[];
  tableApi: TableApi;
}> {
  // Initialize each ExsatApi concurrently
  const exsatApis = await Promise.all(
    accountInfos.map(async (accountInfo) => {
      const api = new ExsatApi(accountInfo);
      await api.initialize();
      return api;
    })
  );

  const tableApi = await TableApi.getInstance();
  return { exsatApis, tableApi };
}

/**
 * Schedules cron jobs using the provided job handlers.
 */
function setupCronJobs(jobs: BatchValidatorJobs, roleType: RoleType) {
  const cronJobs = [
    { schedule: VALIDATOR_JOBS_ENDORSE, job: jobs.endorse },
    { schedule: VALIDATOR_JOBS_ENDORSE_CHECK, job: jobs.endorseCheck },
    { schedule: HEARTBEAT_JOBS, job: jobs.heartbeat },
  ];

  cronJobs.forEach(({ schedule, job }) => {
    cron.schedule(schedule, async () => {
      try {
        await job();
      } catch (error) {
        // Improved error logging using template literals
        logger.error(`Unhandled error in ${job.name} job:`, error);
        errorTotalCounter.inc({
          account: "batch.xsat.validator",
          client: roleType,
        });
      }
    });
  });
}

/**
 * Main function to initialize the network configurations, APIs, jobs, and Prometheus metrics.
 */
async function main() {
  await loadNetworkConfigurations();
  configureLogger(Client.Validator);
  await batchValidatorEnvCheck();

  // Read all keystore files from the directory
  const keystoreFiles = await fs.readdir(VALIDATOR_KEYSTORE_DIR);

  // Filter and process keystore files concurrently (exclude fee_keystore.json)
  const accountInfos = await Promise.all(
    keystoreFiles
      .filter(file => file.endsWith('_keystore.json') && file !== 'fee_keystore.json')
      .map(async (file) => {
        const filePath = path.join(VALIDATOR_KEYSTORE_DIR, file);
        return getAccountInfo(filePath, VALIDATOR_KEYSTORE_DIR_PASSWORD);
      })
  );

  const { exsatApis, tableApi } = await setupApis(accountInfos);

  // Initialize the validator state and job handlers
  const state = new BatchValidatorState();
  state.exsatApis = exsatApis;
  state.tableApi = tableApi;
  state.client = Client.XSATValidator;
  const jobs = new BatchValidatorJobs(state);

  setupCronJobs(jobs, RoleType.xsat_validator);
  setupPrometheus();

  // Set Prometheus gauge for each account concurrently
  accountInfos.forEach((accountInfo) => {
    startTimeGauge.set({ account: accountInfo.accountName, client: Client.XSATValidator }, Date.now());
  });
}

// Self-invoking async function to run main and catch top-level errors.
(async () => {
  try {
    await main();
  } catch (e) {
    logger.error(e);
  }
})();
