/**
 * Contrato común de salida de los parsers de extracto del módulo Cashflow.
 *
 * Tanto el adaptador de MercadoPago (`mpLineasParaCashflow`) como el parser de
 * banco BBVA (`parseExtractoBanco`) producen esta misma forma, que es lo que la
 * RPC `cashflow_subir_extracto` espera en `p_lineas`:
 *   [{ fecha, descripcion, monto_bruto, comision, retencion }]
 *
 * `monto_bruto` viene con signo (positivo = entró, negativo = salió), igual que
 * en el extracto. `comision`/`retencion` se separan cuando el extracto las trae
 * desagregadas; en el MVP de MP quedan en 0 (el account_statement da el neto).
 */

export interface CashflowLineaCargada {
  /** YYYY-MM-DD */
  fecha: string;
  descripcion: string;
  /** Lo que entró/salió según el extracto, con signo. */
  monto_bruto: number;
  /** Comisión separada (≥ 0). 0 si el extracto no la desagrega. */
  comision: number;
  /** Impuesto/retención separado (≥ 0). 0 si el extracto no la desagrega. */
  retencion: number;
}

export interface CashflowExtractoParseado {
  saldoInicial: number;
  saldoFinal: number;
  lineas: CashflowLineaCargada[];
  /**
   * Avisos no fatales para mostrar en el preview antes de confirmar (ej. el
   * saldo final derivado no cuadra con el saldo de cierre declarado en el
   * extracto). Nunca bloquean: el usuario decide.
   */
  advertencias?: string[];
}
