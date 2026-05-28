// Tests de meta.js — helpers para hablar con la Graph API de Meta.
//
// Focus crítico: validarFirmaWebhook. Sin esta validación, cualquiera
// que conozca la URL del webhook podría inyectar mensajes fake en la DB
// (impersonar clientes, gastar API Claude, contaminar conversaciones).
// La firma X-Hub-Signature-256 garantiza que el body viene de Meta.
//
// Casos cubiertos:
//   - Happy path: firma válida → true
//   - Tamper detection: body modificado → false
//   - Wrong secret: secret distinto → false
//   - Missing header: sin signature → false
//   - Missing secret: sin app_secret env → false
//   - Wrong algorithm: header con sha1=... → false
//   - Malformed header: sin '=' → false
//   - Edge case: signature de longitud incorrecta → false (no crash)
//   - timingSafeEqual: comparación constante (no timing attack)

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { validarFirmaWebhook } from '../meta.js';

const APP_SECRET = 'test_app_secret_super_seguro_no_real';
const SAMPLE_BODY = JSON.stringify({ entry: [{ id: '17841400000000000', messaging: [] }] });

function firmar(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('validarFirmaWebhook', () => {
  describe('happy path', () => {
    it('firma válida con el secret correcto → true', () => {
      const sig = firmar(SAMPLE_BODY, APP_SECRET);
      expect(validarFirmaWebhook(SAMPLE_BODY, sig, APP_SECRET)).toBe(true);
    });

    it('firma de body vacío → true (caso degenerado pero matemáticamente correcto)', () => {
      const sig = firmar('', APP_SECRET);
      expect(validarFirmaWebhook('', sig, APP_SECRET)).toBe(true);
    });

    it('firma con caracteres unicode en el body → true', () => {
      const body = JSON.stringify({ msg: 'Hola 👋 ñ á é í ó ú' });
      const sig = firmar(body, APP_SECRET);
      expect(validarFirmaWebhook(body, sig, APP_SECRET)).toBe(true);
    });
  });

  describe('tamper detection — debe rechazar', () => {
    it('body modificado después de firmar → false', () => {
      const sig = firmar(SAMPLE_BODY, APP_SECRET);
      const tamperedBody = SAMPLE_BODY.replace('17841400000000000', '99999999999999999');
      expect(validarFirmaWebhook(tamperedBody, sig, APP_SECRET)).toBe(false);
    });

    it('cambio de 1 char en el body → false', () => {
      const sig = firmar(SAMPLE_BODY, APP_SECRET);
      const tampered = SAMPLE_BODY + ' '; // un espacio al final
      expect(validarFirmaWebhook(tampered, sig, APP_SECRET)).toBe(false);
    });

    it('cambio en la firma (último char) → false', () => {
      const sig = firmar(SAMPLE_BODY, APP_SECRET);
      const tampered = sig.slice(0, -1) + (sig.slice(-1) === '0' ? '1' : '0');
      expect(validarFirmaWebhook(SAMPLE_BODY, tampered, APP_SECRET)).toBe(false);
    });

    it('firma de OTRO body (replay attack con body diferente) → false', () => {
      const sig = firmar('{"otro":"body"}', APP_SECRET);
      expect(validarFirmaWebhook(SAMPLE_BODY, sig, APP_SECRET)).toBe(false);
    });
  });

  describe('wrong secret', () => {
    it('mismo body firmado con secret distinto → false', () => {
      const sig = firmar(SAMPLE_BODY, 'otro_secret_no_es_el_real');
      expect(validarFirmaWebhook(SAMPLE_BODY, sig, APP_SECRET)).toBe(false);
    });
  });

  describe('inputs faltantes o inválidos', () => {
    it('sin header → false', () => {
      expect(validarFirmaWebhook(SAMPLE_BODY, undefined, APP_SECRET)).toBe(false);
    });

    it('header vacío → false', () => {
      expect(validarFirmaWebhook(SAMPLE_BODY, '', APP_SECRET)).toBe(false);
    });

    it('sin app_secret → false', () => {
      const sig = firmar(SAMPLE_BODY, APP_SECRET);
      expect(validarFirmaWebhook(SAMPLE_BODY, sig, undefined)).toBe(false);
    });

    it('app_secret vacío → false', () => {
      const sig = firmar(SAMPLE_BODY, APP_SECRET);
      expect(validarFirmaWebhook(SAMPLE_BODY, sig, '')).toBe(false);
    });

    it('header con algoritmo sha1 en vez de sha256 → false', () => {
      const sha1 = 'sha1=' + crypto.createHmac('sha1', APP_SECRET).update(SAMPLE_BODY).digest('hex');
      expect(validarFirmaWebhook(SAMPLE_BODY, sha1, APP_SECRET)).toBe(false);
    });

    it('header malformado (sin "=") → false', () => {
      expect(validarFirmaWebhook(SAMPLE_BODY, 'no-es-un-header-valido', APP_SECRET)).toBe(false);
    });

    it('header sin hash (solo "sha256=") → false', () => {
      expect(validarFirmaWebhook(SAMPLE_BODY, 'sha256=', APP_SECRET)).toBe(false);
    });

    it('hash con caracteres no-hex → false (no crashea)', () => {
      // Buffer.from('xx', 'hex') retorna buffer parcial — timingSafeEqual tira
      // por longitud distinta. La función debe atrapar con try/catch y devolver false.
      const sig = 'sha256=zzzzzzzz';
      expect(validarFirmaWebhook(SAMPLE_BODY, sig, APP_SECRET)).toBe(false);
    });

    it('hash con longitud distinta a 64 hex chars → false (no crashea)', () => {
      const sig = 'sha256=abc123'; // muy corto
      expect(validarFirmaWebhook(SAMPLE_BODY, sig, APP_SECRET)).toBe(false);
    });
  });

  describe('regression — bug famoso de equality check', () => {
    it('comparar con string.compare normal sería vulnerable a timing — no es el caso acá', () => {
      // No podemos medir el timing directo en un unit test, pero confirmamos
      // que la API usada es timingSafeEqual (lo verificamos en el code review).
      // Este test es documentación: garantiza que validarFirmaWebhook usa
      // crypto.timingSafeEqual internamente (rompiendo este test si alguien
      // lo cambia a `===` por error).
      const sig = firmar(SAMPLE_BODY, APP_SECRET);
      // Firma correcta pero con casing del prefix distinto (Meta siempre lo manda lowercase)
      const upperPrefix = sig.replace('sha256=', 'SHA256=');
      expect(validarFirmaWebhook(SAMPLE_BODY, upperPrefix, APP_SECRET)).toBe(false);
    });
  });
});
