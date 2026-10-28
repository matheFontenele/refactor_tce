/**
 * URL da API para chamadas feitas no navegador.
 *
 * NEXT_PUBLIC_API_URL continua disponível para ambientes que usam DNS,
 * reverse proxy ou uma porta diferente. Sem essa variável, usamos o mesmo
 * host que entregou o frontend; isso evita que `localhost` aponte para a
 * máquina do usuário em produção.
 */
export function getApiUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  if (typeof window !== "undefined") {
    return `http://${window.location.hostname}:9001`;
  }

  return "http://localhost:9001";
}
