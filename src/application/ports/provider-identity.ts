/**
 * PONTO DE EXTENSÃO de autenticação/autorização (ver ARCHITECTURE.md §Autenticação).
 * A implementação padrão é no-op. Com um IdP (ex.: Keycloak/OIDC), o adaptador validaria o JWT (JWKS) e
 * mapearia `azp`/roles do token para os providerIds que o chamador pode representar.
 */
export interface Principal {
  subject: string;
  providerIds: readonly string[] | '*';
}

export abstract class ProviderIdentityPort {
  /** Lança ForbiddenError se o principal não pode agir em nome de `providerId`. */
  abstract assertCanActFor(principal: Principal | undefined, providerId: string): void;
}

export class NoopProviderIdentity extends ProviderIdentityPort {
  assertCanActFor(): void {
    /* autenticação não implementada: ver ARCHITECTURE.md */
  }
}
