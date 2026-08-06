import { ChronikClient } from 'chronik-client'
import { XEC_DUST_SATS } from '../src/config/xecFees'
import { encodeTm1Draft02Post } from '../src/integrations/tonalliMemo/tm1Draft02'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_LOCKTIME,
  TM1_DRAFT_02_SEQUENCE,
  TM1_DRAFT_02_SIGHASH_POLICY,
  TM1_DRAFT_02_TX_VERSION,
  createTm1Draft02Candidate,
