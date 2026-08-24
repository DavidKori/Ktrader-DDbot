/**
 * Deriv DBot XML Auto-Generator
 * -----------------------------
 * Produces Blockly-XML strategies compatible with Deriv DBot's bot-builder.
 * The generated XML can be:
 *   - Loaded into the existing DBot Blockly editor via load-modal.
 *   - Saved to a `.xml` file for the user.
 *   - Executed directly by the existing DBot runner (which just consumes
 *     the same XML internally).
 *
 * The XML matches Deriv's current Blockly v10 layout (variables are
 * case-insensitive in v10+; we emit canonical lowercase names).
 *
 * Reference: https://github.com/deriv-com/bot (CLAUDE.md + tests/strategies).
 */
import type { ScanResult } from '../scanner/market-scanner';

export interface XMLStrategyInputs {
    symbol: string;
    contractType: 'CALL' | 'PUT' | 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITOVER' | 'DIGITUNDER' |
                  'MULTUP' | 'MULTDOWN';
    stake: number;
    durationTicks?: number;          // for binary
    barrier?: number;                 // for OVER/UNDER
    targetDigit?: number;             // for MATCH/DIFF
    martingaleMultiplier?: number;    // optional safety recovery (1 = no martingale)
    takeProfit?: number;              // USD
    stopLoss?: number;                // USD
    currency?: string;                // 'USD'
    botName?: string;
}

const esc = (s: string | number | undefined): string =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * Build the variable definitions block — Deriv DBot expects these by ID/name
 * so the trade-options block can reference them.
 */
const variables = (): string => `
  <variables>
    <variable id="stake_var">stake</variable>
    <variable id="tp_var">takeprofit</variable>
    <variable id="sl_var">stoploss</variable>
    <variable id="mult_var">martingale</variable>
  </variables>`;

/**
 * Map our contract-type to Deriv's trade definition tradeoption value
 * (lowercase strings exactly as DBot expects).
 */
const tradeDefMap: Record<XMLStrategyInputs['contractType'], { type: string; cat: string }> = {
    CALL:        { type: 'callput', cat: 'higherlower'  },
    PUT:         { type: 'callput', cat: 'higherlower'  },
    DIGITMATCH:  { type: 'digits',  cat: 'matchesdiffers' },
    DIGITDIFF:   { type: 'digits',  cat: 'matchesdiffers' },
    DIGITOVER:   { type: 'digits',  cat: 'overunder'      },
    DIGITUNDER:  { type: 'digits',  cat: 'overunder'      },
    MULTUP:      { type: 'multiplier', cat: 'multiplier'  },
    MULTDOWN:    { type: 'multiplier', cat: 'multiplier'  },
};

const purchaseLabel: Record<XMLStrategyInputs['contractType'], string> = {
    CALL:'CALL', PUT:'PUT',
    DIGITMATCH:'DIGITMATCH', DIGITDIFF:'DIGITDIFF',
    DIGITOVER:'DIGITOVER',  DIGITUNDER:'DIGITUNDER',
    MULTUP:'MULTUP', MULTDOWN:'MULTDOWN',
};

export const generateXML = (i: XMLStrategyInputs): string => {
    const tp = i.takeProfit ?? 5;
    const sl = i.stopLoss   ?? 5;
    const martingale = i.martingaleMultiplier ?? 1;
    const ccy = i.currency ?? 'USD';
    const td  = tradeDefMap[i.contractType];
    const botName = i.botName ?? `TradeWithKen-${i.symbol}-${Date.now()}`;
    const durationTicks = i.durationTicks ?? 5;

    // Prediction value (digit / barrier)
    let predictionValue: number | undefined;
    if (i.contractType === 'DIGITMATCH' || i.contractType === 'DIGITDIFF') predictionValue = i.targetDigit ?? 0;
    if (i.contractType === 'DIGITOVER'  || i.contractType === 'DIGITUNDER') predictionValue = i.barrier ?? 5;

    return `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">
  <variables>
    <variable id="stake_var">stake</variable>
    <variable id="tp_var">takeprofit</variable>
    <variable id="sl_var">stoploss</variable>
    <variable id="mult_var">martingale</variable>
  </variables>

  <block type="trade_definition" id="trade_def_${esc(botName)}" x="0" y="0">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" id="market_${esc(i.symbol)}">
        <field name="MARKET_LIST">${esc(i.symbol.startsWith('frx') ? 'forex' : 'synthetic_index')}</field>
        <field name="SUBMARKET_LIST">${esc(i.symbol.startsWith('frx') ? 'major_pairs' : 'random_index')}</field>
        <field name="SYMBOL_LIST">${esc(i.symbol)}</field>
        <next>
          <block type="trade_definition_tradetype" id="ttype_${esc(i.symbol)}">
            <field name="TRADETYPECAT_LIST">${esc(td.cat)}</field>
            <field name="TRADETYPE_LIST">${esc(td.type)}</field>
            <next>
              <block type="trade_definition_contracttype" id="ctype_${esc(i.symbol)}">
                <field name="TYPE_LIST">${esc(purchaseLabel[i.contractType])}</field>
                <next>
                  <block type="trade_definition_candleinterval" id="candle_${esc(i.symbol)}">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_restartbuysell" id="rbs_${esc(i.symbol)}">
                        <field name="TIME_MACHINE_ENABLED">FALSE</field>
                        <next>
                          <block type="trade_definition_restartonerror" id="roe_${esc(i.symbol)}">
                            <field name="RESTARTONERROR">TRUE</field>
                          </block>
                        </next>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>

    <statement name="SUBMARKET">
      <block type="trade_definition_tradeoptions" id="topts_${esc(i.symbol)}">
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">${esc(ccy)}</field>
        <value name="DURATION">
          <shadow type="math_number"><field name="NUM">${esc(durationTicks)}</field></shadow>
        </value>
        <value name="AMOUNT">
          <block type="variables_get">
            <field name="VAR" id="stake_var">stake</field>
          </block>
        </value>
        ${predictionValue !== undefined ? `
        <value name="PREDICTION">
          <shadow type="math_number"><field name="NUM">${esc(predictionValue)}</field></shadow>
        </value>` : ''}
      </block>
    </statement>

    <statement name="INITIALIZATION">
      <block type="variables_set" id="init_stake">
        <field name="VAR" id="stake_var">stake</field>
        <value name="VALUE"><block type="math_number"><field name="NUM">${esc(i.stake)}</field></block></value>
        <next>
          <block type="variables_set" id="init_tp">
            <field name="VAR" id="tp_var">takeprofit</field>
            <value name="VALUE"><block type="math_number"><field name="NUM">${esc(tp)}</field></block></value>
            <next>
              <block type="variables_set" id="init_sl">
                <field name="VAR" id="sl_var">stoploss</field>
                <value name="VALUE"><block type="math_number"><field name="NUM">${esc(sl)}</field></block></value>
                <next>
                  <block type="variables_set" id="init_mart">
                    <field name="VAR" id="mult_var">martingale</field>
                    <value name="VALUE"><block type="math_number"><field name="NUM">${esc(martingale)}</field></block></value>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
  </block>

  <block type="before_purchase" id="before_purchase_root" x="450" y="0">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="controls_if" id="check_tp_sl">
        <value name="IF0">
          <block type="logic_compare">
            <field name="OP">LT</field>
            <value name="A">
              <block type="read_details"><field name="DETAIL_INDEX">5</field></block>
            </value>
            <value name="B">
              <block type="variables_get"><field name="VAR" id="tp_var">takeprofit</field></block>
            </value>
          </block>
        </value>
        <statement name="DO0">
          <block type="purchase" id="purchase_block">
            <field name="PURCHASE_LIST">${esc(purchaseLabel[i.contractType])}</field>
          </block>
        </statement>
      </block>
    </statement>
  </block>

  <block type="after_purchase" id="after_purchase_root" x="900" y="0">
    <statement name="AFTERPURCHASE_STACK">
      <block type="controls_if" id="mart_logic">
        <value name="IF0">
          <block type="contract_check_result"><field name="CHECK_RESULT">loss</field></block>
        </value>
        <statement name="DO0">
          <block type="variables_set" id="mart_update">
            <field name="VAR" id="stake_var">stake</field>
            <value name="VALUE">
              <block type="math_arithmetic">
                <field name="OP">MULTIPLY</field>
                <value name="A"><block type="variables_get"><field name="VAR" id="stake_var">stake</field></block></value>
                <value name="B"><block type="variables_get"><field name="VAR" id="mult_var">martingale</field></block></value>
              </block>
            </value>
          </block>
        </statement>
        <next>
          <block type="trade_again" id="trade_again_block"/>
        </next>
      </block>
    </statement>
  </block>
</xml>`;
};

/**
 * Build a strategy XML directly from a scanner result. Convenience wrapper.
 */
export const xmlFromScan = (scan: ScanResult, stake = 1, durationTicks = 5): string | null => {
    if (!scan.contractType) return null;
    return generateXML({
        symbol: scan.symbol,
        contractType: scan.contractType,
        stake,
        durationTicks,
        barrier: scan.barrier,
        targetDigit: scan.entryDigit,
        botName: `TWK-${scan.symbol}-${scan.strategy.replace(/\W+/g, '_')}`,
    });
};

/** Download helper used by the React component. */
export const downloadXML = (xml: string, fileName = 'tradewithken-strategy.xml') => {
    if (typeof document === 'undefined') return;
    const blob = new Blob([xml], { type: 'application/xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};
