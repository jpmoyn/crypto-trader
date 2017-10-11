import {
  path,
  filter,
  mapObjIndexed,
  toPairs,
} from 'ramda';
import * as bfs from './bfs';

export const nonZeroBalances = filter(x => x > 0);

const toBTC = (value: number, currency: string, tickers: Tickers) => {
  if (currency === 'BTC') return value;
  if (currency === 'USDT') return value / tickers.USDT_BTC.last;
  return value * path<number>([`BTC_${currency}`, 'last'], tickers);
};

export const btcToUSD = (value: number, tickers: Tickers) => {
  return value * tickers.USDT_BTC.last;
};

export const toUSD = (balances: Balances, tickers: Tickers): Balances => {
  const convert = (value, currency) => {
    const btc = toBTC(value, currency, tickers);
    return btcToUSD(btc, tickers);
  };
  return mapObjIndexed(
    convert,
    nonZeroBalances(balances),
  );
};

export const toCAD = (balances: Balances, tickers: Tickers, usdPerCad: number) => {
  const convert = (value, currency) => {
    const btc = toBTC(value, currency, tickers);
    return btcToUSD(btc, tickers) / usdPerCad;
  };
  return mapObjIndexed(convert, nonZeroBalances(balances));
};

function setEdgeValue(edges, start, end, value) {
  if (!edges[start]) edges[start] = {};
  edges[start][end] = value;
}

type RateFromAtoB = number; // 1 a = RateFromAtoB b
export function tickersToGraph(tickers: Tickers): bfs.Graph<RateFromAtoB> {
  const nodes = new Set();
  const edges = {};

  for (const [currencyPair, ticker] of toPairs<string, Ticker>(tickers)) {
    const [base, token] = currencyPair.split('_');
    nodes.add(base);
    nodes.add(token);
    setEdgeValue(edges, base, token, 1 / ticker.last);
    setEdgeValue(edges, token, base, ticker.last);
  }

  return {
    nodes,
    edges,
  };
}

export function estimate(fromAmount: number, fromCoin: string, toCoin: string, tickers: Tickers): number {
  const graph = tickersToGraph(tickers);
  const rates = bfs.bfs(graph, fromCoin, toCoin);
  if (!rates) throw new Error(`Cannot convert ${fromCoin} to ${toCoin}.`);
  const rate = rates.reduce((a, b) => a * b, 1);
  return fromAmount * rate;
}
