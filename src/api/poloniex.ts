import '../types/api'
import * as request from 'request-promise-native'
import * as crypto from 'crypto'
import * as R from 'ramda'
import { throttle } from 'lodash'
import * as qs from 'query-string'
import { PROD } from '../constants'

const PUBLIC_API = 'https://poloniex.com/public'
const TRADING_API = 'https://poloniex.com/tradingApi'
const API_KEY = process.env.POLONIEX_API_KEY
const API_SECRET = process.env.POLONIEX_API_SECRET

if (!API_SECRET || !API_KEY) throw new Error('POLONIEX_API_KEY or POLONIEX_API_SECRET missing.');

function signature(body) {
  const hmac = crypto.createHmac('sha512', API_SECRET)
  hmac.update(body)
  return hmac.digest('hex')
}

function getBody(command, options) {
  const body = R.merge(options, {
    nonce: Date.now() * 1000,
    command,
  })
  return qs.stringify(body)
}

function handleResponse(rawData) {
  const data = JSON.parse(rawData)
  if (data.error) {
    throw new Error(data.error)
  } else {
    return data
  }
}

async function makeRequest(params) {
  console.log(`API CALL: ${JSON.stringify(params)}`)
  try {
    return handleResponse(await request(params))
  } catch (e) {
    if (e.error) {
      throw new Error(JSON.parse(e.error).error)
    }
    throw e
  }
}

function post(command, options = {}) {
  const body = getBody(command, options)

  const params = {
    method: 'POST',
    url: TRADING_API,
    form: body,
    headers: {
      Key: API_KEY,
      Sign: signature(body),
    },
  }

  return makeRequest(params)
}

function get(command, options = {}) {
  const query = qs.stringify(R.merge({ command }, options))

  const params = {
    method: 'GET',
    url: `${PUBLIC_API}?${query}`
  }

  return makeRequest(params)
}

const parseResponseOrder = (isBuyOrder) => R.pipe(
  R.prop('resultingTrades'),
  R.map(R.pipe(
    R.prop(isBuyOrder ? 'amount' : 'total'),
    parseFloat,
  )),
  R.sum
)

const makeTradeCommand = (command) => async ({
  amount,
  currencyPair,
  rate,
}) => {
  const toAmount = parseResponseOrder(command === 'buy')

  const response = await post(command, {
    amount,
    currencyPair,
    fillOrKill: '1',
    immediateOrCancel: '1',
    rate,
  })

  return toAmount(response)
}

async function logged(s, x): Promise<undefined> {
  console.log(s, x)
  return undefined
}

// Balances is [string]: number, this is the intermediate step.
interface PoloniexBalances {
  [currency: string]: string
}

async function balances(): Promise<Balances> {
  const balances = await post('returnBalances') as PoloniexBalances
  return R.map(parseFloat, balances) as Balances
}

interface PoloniexTicker {
  currencyPair: string
  last: string
  lowestAsk: string
  highestBid: string
  percentChange: string
  baseVolume: string
  quoteVolume: string
  isFrozen: string
  '24hrHigh': string
  '24hrLow': string
}

interface PoloniexTickers {
  [currencyPair: string]: PoloniexTicker
}

async function tickers(): Promise<Tickers> {
  const tickers: Promise<PoloniexTickers> = await get('returnTicker')
  return R.mapObjIndexed((ticker: PoloniexTicker, currencyPair: string) => ({
    last: parseFloat(ticker.last),
    lowestAsk: parseFloat(ticker.lowestAsk),
    highestBid: parseFloat(ticker.highestBid),
    percentChange: parseFloat(ticker.percentChange),
    baseVolume: parseFloat(ticker.baseVolume),
    quoteVolume: parseFloat(ticker.quoteVolume),
    isFrozen: !!parseInt(ticker.isFrozen),
    '24hrHigh': parseFloat(ticker['24hrHigh']),
    '24hrLow': parseFloat(ticker['24hrLow']),
    currencyPair,
  }), tickers)
}

interface PoloniexApi extends Api {}

const api: PoloniexApi = {
  balances,
  tickers: throttle(tickers, 1000, { leading: true, trailing: false }),
  sell: PROD ? makeTradeCommand('sell') : (x => logged('sell', x)),
  buy: PROD ? makeTradeCommand('buy') : (x => logged('buy', x)),
}

export default api
