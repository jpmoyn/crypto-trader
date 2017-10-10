import * as R from 'ramda';
import * as strategy from '../operations/strategy';
import trade from '../operations/trade';
import summary from '../operations/summary';
import { performanceByExchange } from '../operations/performance';
import { poloniex, coinbase, bittrex } from '../api';
import { getRate, getUsdPerCad } from '../fiat';
import * as auth from '../auth';
import {
  formatPerformances,
  formatAddresses,
  formatBalances,
  formatPairs,
  log,
  nonZeroBalances,
  setLogger,
  toCAD,
  toUSD,
  withHandledLoginErrors,
} from '../utils';
const yesno = require('yesno');
const Table = require('cli-table');
const prompt = require('prompt');

const cli = require('vorpal')();
const ask = (question: string, def: any) => new Promise((r) => {
  yesno.ask(question, def, r);
});

const supportedExchanges = [
  'bittrex',
  'poloniex',
  'coinbase',
];

const exchangeOptDesc = 'The name of the exchange to query. (default = poloniex)';

function ex(exchange: string = 'poloniex'): Api {
  switch (exchange) {
    case 'pl':
    case 'pn':
    case 'polo':
    case 'poloniex': return poloniex;

    case 'cb':
    case 'coinbase': return coinbase;

    case 'br':
    case 'bittrex': return bittrex;

    default: throw new Error('Unsupported exchange');
  }
}

cli.command('login <exchange>', 'Setup api keys and secrets for an exchange.')
  .action((args: any, callback: Function) => {
    const api = ex(args.exchange);

    prompt.start();
    prompt.message = '';
    prompt.delimiter = '';
    prompt.get(['API_KEY', 'API_SECRET'], (err, result) => {
      auth.setKey(api.name as ExchangeName, result.API_KEY);
      auth.setSecret(api.name as ExchangeName, result.API_SECRET);
      auth.save();
      api.init();
      callback();
    });
  });

cli.command('balances [coins...]', 'Display your current balances.')
  .alias('balance')
  .alias('b')
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const api = ex(args.options.exchange);
    const [tickers, balances, usdPerCad] = await Promise.all([
      api.tickers(),
      api.balances(),
      getUsdPerCad(),
    ]);
    const nzBalances = nonZeroBalances(balances);
    const cryptoBalances = args.coins
      ? R.pick(
        R.map(
          R.toUpper,
          args.coins,
        ) as string[],
        nzBalances,
      ) as any
      : nzBalances;
    const cadBalances = toCAD(balances, tickers, usdPerCad) as any;

    log(formatBalances(cryptoBalances, toCAD(cryptoBalances, tickers, usdPerCad)));

    callback();
  }));

cli.command('split <amount> <fromCoin> <coins...>', 'Split your coin into coins.')
  .option('-d, --dry-run', `Don't actually perform the trade, make a dry run to see what it would look like.`)
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const params = {
      amount: parseFloat(args.amount),
      api: ex(args.options.exchange),
      fromCoin: args.fromCoin.toUpperCase(),
      strategy: strategy.namedListStrategy(args.coins as string[]),
      isDryRun: args.options['dry-run'],
    };
    const ok = await ask(
      `Are you sure you want to turn ${params.amount} ${params.fromCoin} into ${params.strategy.value.join(', ')} on ${params.api.name}? [y/n]`,
      null,
    );
    if (ok) {
      await strategy.execute(
        params.api,
        params.amount,
        params.strategy,
        params.fromCoin,
        params.isDryRun,
      );
    } else {
      log('Ok! Not doing it.');
    }
    callback();
  }));

cli.command('diversify <amount> <fromCoin>', 'Split your coin into n top coins by volume.')
  .option('-n, --into [n]', 'Amount of top coins to deversify into. (default = 30)')
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .option('-d, --dry-run', `Don't actually perform the trade, make a dry run to see what it would look like.`)
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const params = {
      amount: parseFloat(args.amount),
      api: ex(args.options.exchange),
      fromCoin: args.fromCoin.toUpperCase(),
      isDryRun: args.options['dry-run'],
      strategy: strategy.topByVolumeStrategy(
        args.options.into ? parseInt(args.options.into, 10) : 30,
      ),
    };
    const ok = await ask(
      `Are you sure you want to turn ${params.amount} ${params.fromCoin} into ${params.strategy.n} top coins by volume on ${params.api.name}? [y/n]`,
      null,
    );
    if (ok) {
      await strategy.execute(
        params.api,
        params.amount,
        params.strategy,
        params.fromCoin,
        params.isDryRun,
      );
    } else {
      log('Ok! Not doing it.');
    }
    callback();
  }));

cli.command('trade <amount> <fromCoin> <toCoin> <currencyPair>', 'Trade fromCoin toCoin on given currency pair.')
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .option('-d, --dry-run', `Don't actually perform the trade, make a dry run to see what it would look like.`)
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const api = ex(args.options.exchange);
    const params = {
      exchange: api,
      amount: parseFloat(args.amount),
      fromCoin: args.fromCoin.toUpperCase(),
      toCoin: args.toCoin.toUpperCase(),
      pair: args.currencyPair.toUpperCase(),
      isDryRun: args.options['dry-run'],
    };
    const tickers = await api.tickers();
    const ok = await ask(
      `Are you sure you want to trade ${params.amount} ${params.fromCoin} into ${params.toCoin} on ${params.exchange.name}? \n` +
      `Current sellRate is ${api.sellRate(params.pair, tickers)} ${params.pair.replace('_', '/')}\n` +
      `Current buyRate is ${api.buyRate(params.pair, tickers)} ${params.pair.replace('_', '/')}\n` +
      `[y/n]`,
      null,
    );

    if (ok) {
      try {
        const result = await trade({
          api: params.exchange,
          fromAmount: params.amount,
          fromCoin: params.fromCoin,
          toCoin: params.toCoin,
          currencyPair: params.pair,
          isDryRun: params.isDryRun,
        });
        log(`SUCCESS: GOT ${result} ${params.toCoin} FROM ${params.amount} ${params.fromCoin}`);
      } catch (e) {
        log(`FAILURE: COULD NOT TRADE`);
      }
    } else {
      log('OK! Not doing it!');
    }

    callback();
  }));

const pp = (x: number) => x.toFixed(2);

cli.command('summary', 'Displays your portfolio summary.')
  .hidden()
  .option('-r, --rate [rate]', 'the CAD/USD rate.')
  .option('-b, --buy-rate [buyRate]', 'the CAD/USD rate at which you bought.')
  .option('-c, --current-rate [currentRate]', 'the CAD/USD rate today.')
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const table = new Table({
      head: ['Description', 'CAD', 'USD'],
      colAligns: ['left', 'right', 'right'],
    });

    const {
      buyRate,
      coinbaseFee,
      currentRate,
      estimatedUSDTotal,
      exchangeFee,
      totalAfterFees,
      totalSpent,
      roiAfterFees,
      roiOnMoneySpent,
      coinbaseFees,
      exchangeFees,
      totalFees,
    } = await summary(args);

    table.push([
      'total spent',
      pp(totalSpent),
      pp(totalSpent * buyRate),
    ]);
    table.push([
      'coinbase fees',
      pp(coinbaseFees),
      pp(coinbaseFees * buyRate),
    ]);

    table.push([
      'exchange fees',
      pp(exchangeFees),
      pp(exchangeFees * buyRate),
    ]);

    table.push([
      'total fees',
      pp(totalFees),
      pp(totalFees * buyRate),
    ]);

    table.push([
      'total after fees',
      pp(totalAfterFees),
      pp(totalAfterFees * buyRate),
    ]);

    table.push([
      'estimated portfolio value',
      pp(estimatedUSDTotal / currentRate),
      pp(estimatedUSDTotal),
    ]);

    table.push([
      'ROI (after fees)',
      '-',
      pp(roiAfterFees) + '%',
    ]);

    table.push([
      'ROI (on money spent)',
      '-',
      pp(roiOnMoneySpent) + '%',
    ]);

    log(table.toString());
    callback();
  }));

cli.command('pairs [currencies...]', 'List all the currency pairs on the exchange.')
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const api = ex(args.options.exchange);
    const tickers = await api.tickers();
    log(formatPairs(tickers, args.currencies));
    callback();
  }));

cli.command('quote [currency]', 'Get a quote for a currency in USD.')
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const api = ex(args.options.exchange);
    const currency = args.currency.toUpperCase() as string;
    if (R.contains(currency, ['CAD', 'EUR'])) {
      const rate = await getRate(currency, 'USD');
      log(`1 ${currency} = ${rate} USD`);
    } else {
      const rate = await getUsdPerCad();
      const tickers = await api.tickers();
      const balances = {
        [currency]: 1,
      };
      const usd = toUSD(balances, tickers)[currency.toUpperCase()];
      const cad = usd / rate;
      log(`1 ${currency} = ${usd.toFixed(5)} USD`);
      log(`1 ${currency} = ${cad.toFixed(5)} CAD`);
    }
    callback();
  }));

cli.command('addresses [currency]', 'Get a list of cryptocurrency deposit addresses from an exchange.')
  .alias('address')
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const api = ex(args.options.exchange);
    const currency = (args.currency || '').toUpperCase() as string;
    const addresses = await api.addresses();
    if (currency) {
      log(currency, ':', addresses[currency]);
    } else {
      log(formatAddresses(addresses));
    }
    callback();
  }));

cli.command('performance [currencies...]', 'Get a list of performances by exchange.')
  .alias('performances')
  .alias('perf')
  .option('-x, --exchange [exchange]', exchangeOptDesc, supportedExchanges)
  .option('-s, --sort-by [method]', 'The column to sort by', ['profit', 'usd', 'percent'])
  .action(withHandledLoginErrors(async (args: any, callback: Function) => {
    const api = ex(args.options.exchange);
    const [tickers, trades] = await Promise.all([
      api.tickers(),
      api.trades(),
    ]);
    log(formatPerformances(
      performanceByExchange(trades, tickers),
      tickers,
      (args.currencies || []).map(x => x.toUpperCase()),
      args.options['sort-by'],
    ));
    callback();
  }));


export function run() {
  setLogger(cli.log.bind(cli));
  cli.delimiter('crypto-trader $ ')
    .history('crypto-trader-ching-ching')
    .show();
}