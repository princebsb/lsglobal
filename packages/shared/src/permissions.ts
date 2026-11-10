/**
 * Matriz de permissões (RBAC). A verificação efetiva acontece SEMPRE no back-end,
 * combinada com autorização contextual (tenant/condomínio) e elegibilidade (para votar).
 *
 * Votar NÃO é uma permissão administrativa: depende de credenciamento ativo da pessoa
 * vinculada ao usuário como representante da unidade. Nenhum perfil pode alterar votos.
 */
export const PERMISSIONS = {
  'platform.dashboard.view': 'Visualizar painel global LS Global',
  'platform.tenants.manage': 'Criar e administrar clientes contratantes',
  'platform.tenants.access': 'Acessar dados de um cliente (acesso administrativo auditado)',
  'platform.audit.view': 'Consultar auditoria de toda a plataforma',
  'tenant.settings.manage': 'Administrar dados e identidade do cliente',
  'tenant.users.manage': 'Administrar usuários e perfis do cliente',
  'condo.view': 'Visualizar condomínios',
  'condo.manage': 'Cadastrar e alterar condomínios, blocos e unidades',
  'people.view': 'Visualizar condôminos (dados mascarados)',
  'people.manage': 'Cadastrar condôminos e vínculos com unidades',
  'people.view_sensitive': 'Visualizar documentos pessoais completos',
  'poa.submit': 'Registrar procurações',
  'poa.review': 'Analisar, aprovar, rejeitar e revogar procurações',
  'rules.manage': 'Criar regras de quórum (rascunho)',
  'rules.approve': 'Homologar regras de quórum',
  'assembly.view': 'Visualizar assembleias',
  'assembly.manage': 'Criar e planejar assembleias e pautas',
  'assembly.homologate': 'Homologar regras aplicáveis à assembleia',
  'assembly.convene': 'Redigir, publicar e enviar o edital de convocação',
  'assembly.conduct': 'Conduzir a assembleia (mesa diretora): sessões e votações',
  'assembly.accredit': 'Credenciar participantes',
  'assembly.attend': 'Participar da assembleia como condômino/procurador',
  'votes.view_nominal': 'Consultar votos nominais individuais (votações não sigilosas)',
  'results.view': 'Visualizar apurações e resultados',
  'reports.export': 'Exportar relatórios',
  'audit.view': 'Consultar trilha de auditoria do cliente',
  'tech.operate': 'Operação técnica audiovisual',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type RoleScope = 'platform' | 'tenant' | 'condominium';

export interface RoleDef {
  code: string;
  name: string;
  scope: RoleScope;
  requiresMfa: boolean;
  permissions: Permission[];
}

const VIEW_BASE: Permission[] = ['condo.view', 'people.view', 'assembly.view', 'results.view'];

export const ROLES: readonly RoleDef[] = [
  {
    code: 'platform_superadmin',
    name: 'Superadministrador LS Global',
    scope: 'platform',
    requiresMfa: true,
    permissions: [
      'platform.dashboard.view',
      'platform.tenants.manage',
      'platform.tenants.access',
      'platform.audit.view',
      'tenant.settings.manage',
      'tenant.users.manage',
      ...VIEW_BASE,
      'audit.view',
      'reports.export',
    ],
  },
  {
    code: 'platform_operations',
    name: 'Administrador operacional LS Global',
    scope: 'platform',
    requiresMfa: true,
    permissions: ['platform.dashboard.view', 'platform.tenants.access', ...VIEW_BASE, 'tech.operate', 'audit.view'],
  },
  {
    code: 'platform_commercial',
    name: 'Administrador comercial LS Global',
    scope: 'platform',
    requiresMfa: true,
    permissions: ['platform.dashboard.view', 'platform.tenants.manage'],
  },
  {
    code: 'tenant_admin',
    name: 'Administradora de condomínios (administrador do cliente)',
    scope: 'tenant',
    requiresMfa: true,
    permissions: [
      'tenant.settings.manage',
      'tenant.users.manage',
      ...VIEW_BASE,
      'condo.manage',
      'people.manage',
      'people.view_sensitive',
      'poa.submit',
      'poa.review',
      'rules.manage',
      'rules.approve',
      'assembly.manage',
      'assembly.homologate',
      'assembly.convene',
      'assembly.accredit',
      'reports.export',
      'audit.view',
      'votes.view_nominal',
    ],
  },
  {
    code: 'sindico',
    name: 'Síndico',
    scope: 'condominium',
    requiresMfa: true,
    permissions: [
      ...VIEW_BASE,
      'condo.manage',
      'people.manage',
      'poa.submit',
      'poa.review',
      'rules.manage',
      'rules.approve',
      'assembly.manage',
      'assembly.homologate',
      'assembly.convene',
      'assembly.accredit',
      'reports.export',
      'audit.view',
      'votes.view_nominal',
    ],
  },
  {
    code: 'subsindico',
    name: 'Subsíndico',
    scope: 'condominium',
    requiresMfa: true,
    permissions: [...VIEW_BASE, 'people.manage', 'poa.submit', 'assembly.manage', 'assembly.accredit', 'reports.export'],
  },
  {
    code: 'assembly_president',
    name: 'Presidente da assembleia',
    scope: 'condominium',
    requiresMfa: false,
    permissions: [...VIEW_BASE, 'assembly.conduct', 'assembly.accredit', 'reports.export', 'votes.view_nominal'],
  },
  {
    code: 'assembly_secretary',
    name: 'Secretário da assembleia',
    scope: 'condominium',
    requiresMfa: false,
    permissions: [...VIEW_BASE, 'assembly.conduct', 'assembly.accredit', 'reports.export'],
  },
  {
    code: 'technical_operator',
    name: 'Operador técnico',
    scope: 'condominium',
    requiresMfa: false,
    permissions: ['assembly.view', 'tech.operate'],
  },
  {
    code: 'moderator',
    name: 'Moderador',
    scope: 'condominium',
    requiresMfa: false,
    permissions: ['assembly.view', 'tech.operate'],
  },
  {
    code: 'auditor',
    name: 'Fiscal / auditor',
    scope: 'condominium',
    requiresMfa: false,
    permissions: [...VIEW_BASE, 'audit.view', 'reports.export'],
  },
  {
    code: 'accreditation_agent',
    name: 'Apoio ao credenciamento',
    scope: 'condominium',
    requiresMfa: false,
    permissions: ['assembly.view', 'people.view', 'assembly.accredit'],
  },
  {
    code: 'condomino',
    name: 'Condômino',
    scope: 'condominium',
    requiresMfa: false,
    permissions: ['assembly.view', 'assembly.attend', 'results.view', 'poa.submit'],
  },
  {
    code: 'procurador',
    name: 'Procurador',
    scope: 'condominium',
    requiresMfa: false,
    permissions: ['assembly.view', 'assembly.attend', 'results.view'],
  },
  {
    code: 'guest',
    name: 'Convidado autorizado',
    scope: 'condominium',
    requiresMfa: false,
    permissions: ['assembly.view'],
  },
  {
    code: 'av_supplier',
    name: 'Fornecedor audiovisual',
    scope: 'condominium',
    requiresMfa: false,
    permissions: ['tech.operate'],
  },
];

export const ROLE_BY_CODE: ReadonlyMap<string, RoleDef> = new Map(ROLES.map((r) => [r.code, r]));
