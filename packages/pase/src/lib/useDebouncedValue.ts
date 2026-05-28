// AUDIT F7A#1 / sprint #2 post-audit grande: este archivo ahora re-exporta
// desde @pase/shared/utils. Los callers existentes con `from '../lib/useDebouncedValue'`
// siguen funcionando sin cambios (compat layer). Para código nuevo en PASE,
// importar directo desde '@pase/shared/utils'.
//
// Cuando todos los callers se migren, este archivo se puede borrar.
export { useDebouncedValue } from '@pase/shared/utils';
