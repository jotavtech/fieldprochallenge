-- Modelo de dados do PRD §6.
-- Idempotente: pode rodar de novo (`npm run db:migrate`) que recria tudo do zero.

DROP TABLE IF EXISTS notificacoes, dispatch_ondas, operador_favoritos,
                     operador_historico_local, vagas, operadores, locais CASCADE;
DROP TYPE IF EXISTS vaga_status, onda_status, notificacao_status CASCADE;

CREATE TYPE vaga_status         AS ENUM ('aberta', 'confirmada', 'cancelada', 'expirada');
CREATE TYPE onda_status         AS ENUM ('agendada', 'disparando', 'concluida', 'abortada');
CREATE TYPE notificacao_status  AS ENUM ('enfileirada', 'enviada', 'entregue', 'falhou');

-- locais e operadores nao estao no §6 do PRD (que lista so as tabelas do fluxo de dispatch),
-- mas a onda 3 precisa de especialidade + posicao do operador e a UI precisa do nome do local.
CREATE TABLE locais (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome      text NOT NULL,
  timezone  text NOT NULL DEFAULT 'America/Sao_Paulo'
);

CREATE TABLE operadores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            text NOT NULL,
  especialidades  text[] NOT NULL DEFAULT '{}',
  latitude        numeric,
  longitude       numeric,
  timezone        text NOT NULL DEFAULT 'America/Sao_Paulo',  -- §7.6: corte do cap diario e no fuso do operador
  ativo           boolean NOT NULL DEFAULT true,
  push_token      text,
  criado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operadores_especialidades_idx ON operadores USING gin (especialidades);

CREATE TABLE vagas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        uuid NOT NULL REFERENCES locais(id),
  status          vaga_status NOT NULL DEFAULT 'aberta',
  operador_id     uuid REFERENCES operadores(id),   -- preenchido so quando confirmada
  especialidade   text NOT NULL,
  endereco        text NOT NULL,
  latitude        numeric NOT NULL,
  longitude       numeric NOT NULL,
  data_inicio     timestamptz NOT NULL,
  duracao_minutos int NOT NULL,
  valor_centavos  int NOT NULL,
  versao          int NOT NULL DEFAULT 1,           -- incrementa a cada edicao relevante (RF5)
  timezone        text NOT NULL,                    -- ex. "America/Sao_Paulo"
  criada_em       timestamptz NOT NULL DEFAULT now(),
  atualizada_em   timestamptz NOT NULL DEFAULT now(),

  -- RF2: invariante estrutural, nao so aplicacional — vaga confirmada exige operador e vice-versa.
  CONSTRAINT confirmada_tem_operador
    CHECK ((status = 'confirmada') = (operador_id IS NOT NULL))
);
CREATE INDEX vagas_abertas_idx ON vagas (status, data_inicio) WHERE status = 'aberta';

CREATE TABLE dispatch_ondas (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vaga_id                     uuid NOT NULL REFERENCES vagas(id) ON DELETE CASCADE,
  numero_onda                 int NOT NULL CHECK (numero_onda BETWEEN 1 AND 3),
  status                      onda_status NOT NULL DEFAULT 'agendada',
  versao_vaga_no_agendamento  int NOT NULL,         -- §7.3: revalidado no momento do disparo
  disparar_em                 timestamptz NOT NULL,
  disparada_em                timestamptz,
  criada_em                   timestamptz NOT NULL DEFAULT now(),

  -- torna o agendamento idempotente: replanejar nao duplica onda.
  UNIQUE (vaga_id, numero_onda)
);
CREATE INDEX ondas_agendadas_idx ON dispatch_ondas (disparar_em) WHERE status = 'agendada';

CREATE TABLE notificacoes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vaga_id             uuid NOT NULL REFERENCES vagas(id) ON DELETE CASCADE,
  onda_id             uuid NOT NULL REFERENCES dispatch_ondas(id) ON DELETE CASCADE,
  operador_id         uuid NOT NULL REFERENCES operadores(id),
  status              notificacao_status NOT NULL DEFAULT 'enfileirada',
  tentativas          int NOT NULL DEFAULT 0,
  provider_message_id text,                          -- casa o webhook de callback (RF6)
  criada_em           timestamptz NOT NULL DEFAULT now(),
  atualizada_em       timestamptz NOT NULL DEFAULT now(),

  -- o mesmo operador nunca recebe duas notificacoes da mesma vaga, mesmo que caia em
  -- duas ondas (favorito E no raio). O INSERT ... ON CONFLICT DO NOTHING da onda usa isso
  -- como dedupe atomico, o que tambem torna o disparo de onda idempotente sob re-execucao.
  UNIQUE (vaga_id, operador_id)
);
-- RF3: contagem do cap diario por operador.
CREATE INDEX notificacoes_cap_idx ON notificacoes (operador_id, criada_em DESC);
-- RF6: idempotencia do webhook.
CREATE UNIQUE INDEX notificacoes_provider_msg_idx
  ON notificacoes (provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE operador_favoritos (
  local_id     uuid NOT NULL REFERENCES locais(id),
  operador_id  uuid NOT NULL REFERENCES operadores(id),
  PRIMARY KEY (local_id, operador_id)
);

CREATE TABLE operador_historico_local (
  local_id               uuid NOT NULL REFERENCES locais(id),
  operador_id            uuid NOT NULL REFERENCES operadores(id),
  ultima_vez_trabalhou   timestamptz NOT NULL,
  PRIMARY KEY (local_id, operador_id)
);
