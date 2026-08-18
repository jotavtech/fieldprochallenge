-- Apenas as tabelas que o caminho da ACEITAÇÃO toca. O modelo completo do dispatch
-- (dispatch_ondas, notificacoes, operador_favoritos, operador_historico_local) está
-- descrito em DECISOES.md — sem tabela sem código que a use.
--
-- Idempotente: `npm test` roda isto antes de cada execução.

DROP TABLE IF EXISTS vagas, operadores CASCADE;
DROP TYPE IF EXISTS vaga_status CASCADE;

CREATE TYPE vaga_status AS ENUM ('aberta', 'confirmada', 'cancelada', 'expirada');

CREATE TABLE operadores (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome  text NOT NULL
);

CREATE TABLE vagas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          vaga_status NOT NULL DEFAULT 'aberta',
  operador_id     uuid REFERENCES operadores(id),   -- preenchido só quando confirmada
  data_inicio     timestamptz NOT NULL,
  valor_centavos  int NOT NULL,
  criada_em       timestamptz NOT NULL DEFAULT now(),
  atualizada_em   timestamptz NOT NULL DEFAULT now(),

  -- A exclusividade vive no UPDATE condicional (ver DECISOES.md), mas o banco também
  -- recusa estruturalmente os dois estados incoerentes: confirmada sem operador e
  -- operador sem confirmação. Invariante que nenhum bug de aplicação consegue violar.
  CONSTRAINT confirmada_tem_operador
    CHECK ((status = 'confirmada') = (operador_id IS NOT NULL))
);
