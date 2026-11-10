import { describe, expect, it } from 'vitest';
import { isValidCnpj, isValidCpf, maskDocument } from './documents';
import { ALL_PERMISSIONS, ROLES } from './permissions';
import { canTransitionAssembly, canTransitionBallot } from './state';

describe('máquina de estados da assembleia', () => {
  it('segue o fluxo previsto', () => {
    expect(canTransitionAssembly('draft', 'in_review')).toBe(true);
    expect(canTransitionAssembly('in_progress', 'suspended')).toBe(true);
    expect(canTransitionAssembly('suspended', 'in_progress')).toBe(true);
  });
  it('bloqueia transições inválidas', () => {
    expect(canTransitionAssembly('draft', 'in_progress')).toBe(false);
    expect(canTransitionAssembly('archived', 'draft')).toBe(false);
    expect(canTransitionAssembly('closed', 'in_progress')).toBe(false);
  });
});

describe('máquina de estados da votação', () => {
  it('não reabre votação encerrada', () => {
    expect(canTransitionBallot('closed', 'open')).toBe(false);
    expect(canTransitionBallot('declared', 'tallied')).toBe(false);
  });
  it('não cancela após encerramento', () => {
    expect(canTransitionBallot('closed', 'cancelled')).toBe(false);
    expect(canTransitionBallot('open', 'cancelled')).toBe(true);
  });
});

describe('matriz de permissões', () => {
  it('perfis só referenciam permissões existentes', () => {
    for (const r of ROLES) for (const p of r.permissions) expect(ALL_PERMISSIONS).toContain(p);
  });
  it('perfis técnicos não consultam votos nominais', () => {
    for (const code of ['technical_operator', 'moderator', 'av_supplier']) {
      expect(ROLES.find((r) => r.code === code)!.permissions).not.toContain('votes.view_nominal');
    }
  });
});

describe('documentos', () => {
  it('valida CPF e CNPJ', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
  });
  it('mascara documento', () => {
    expect(maskDocument('52998224725')).toBe('***.982.247-**');
  });
});
