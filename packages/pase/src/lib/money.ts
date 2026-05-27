// AUDIT F7A#1: este archivo ahora re-exporta desde @pase/shared/utils/money.
// Los callers no tienen que cambiar — siguen importando desde '../lib/money'.
// Gradualmente se pueden migrar a importar directo de '@pase/shared/utils'.
export { moneyAdd, moneySub, moneyMul, moneyRound, moneyEq, moneyKey, moneySum } from '@pase/shared/utils';
