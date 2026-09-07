import { describe, expect, it } from 'vitest';

import { API_SCOPES, SCOPE_ACTIONS, isApiScope, scopeAllows, unknownScopes } from './api-scopes';

/**
 * Скоупы токена (docs/06-API.md). Скоуп сужает права выдавшего и никогда
 * не расширяет: у каждого есть действие матрицы, которым он проверяется.
 */
describe('список скоупов', () => {
  it('у каждого скоупа есть действие, которым он проверяется', () => {
    for (const scope of API_SCOPES) {
      expect(SCOPE_ACTIONS[scope], scope).toBeDefined();
    }
  });

  it('чужая строка скоупом не считается', () => {
    expect(isApiScope('residents:read')).toBe(true);
    expect(isApiScope('residents:delete')).toBe(false);
    expect(isApiScope('')).toBe(false);
  });

  it('неизвестные скоупы называются поимённо', () => {
    expect(unknownScopes(['residents:read', 'money:steal', 'beds:read'])).toEqual(['money:steal']);
    expect(unknownScopes([...API_SCOPES])).toEqual([]);
  });
});

describe('проверка действия', () => {
  it('скоуп открывает своё действие и только его', () => {
    expect(scopeAllows(['rotations:read'], 'rotation.read')).toBe(true);
    expect(scopeAllows(['rotations:read'], 'rotation.manage')).toBe(false);
  });

  it('без нужного скоупа отказ, даже если скоупов много', () => {
    expect(scopeAllows(['residents:read', 'beds:read', 'houses:read'], 'invoice.read')).toBe(false);
  });

  it('неизвестный скоуп не открывает ничего', () => {
    expect(scopeAllows(['everything:always'], 'invoice.read')).toBe(false);
    expect(scopeAllows([], 'house.read')).toBe(false);
  });

  it('деньги не открываются скоупом мест: у них разные действия', () => {
    expect(scopeAllows(['beds:read'], 'invoice.read')).toBe(false);
    expect(scopeAllows(['invoices:read'], 'bed.read')).toBe(false);
  });
});
