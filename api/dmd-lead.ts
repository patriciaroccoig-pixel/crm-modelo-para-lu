import { createClient } from '@supabase/supabase-js';

// Recebe cada submissão do DMD (dmd.php, no NuvemHost) e grava contato + negócio
// no CRM. Chamado depois que o dmd.php já gravou no MySQL e respondeu a tela —
// se isto falhar, o diagnóstico da cliente não é afetado; o dmd.php só loga.

type ApiRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
};

const ORG_ID = 'ec7de481-395f-448a-8c49-987eb2b86b51';
const PIPELINE_ID = '068792da-1c27-4c4a-aeea-6c04777733e6';
const STAGE_NAME = 'Chegou agora';

// temperatura do DMD (5 estados) -> temperatura do CRM (3 estados)
const TEMPERATURA_CRM: Record<string, 'Frio' | 'Morno' | 'Quente'> = {
  quente: 'Quente',
  atencao: 'Quente',
  morno: 'Morno',
  curioso: 'Morno',
  frio: 'Frio',
};

const NOME_EIXO: Record<string, string> = {
  dia: 'diálogo',
  mat: 'maturidade',
  dir: 'direção',
};

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core não configurado.');
  return createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: 'whatsapp_hub' },
  });
}

interface DmdLeadBody {
  nome: string;
  email: string;
  whatsapp: string;
  instagram?: string | null;
  perfil: 'ele' | 'ela';
  resultado: string; // chave: 'nada' | 'dia' | 'mat' | 'dir'
  acompanha?: string | null;
  temperatura: string; // quente | morno | curioso | frio | atencao
  origem?: Record<string, string | null> | null;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ erro: 'metodo' });

    const secretHeader = req.headers?.['x-dmd-secret'] ?? req.headers?.['X-Dmd-Secret'];
    const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    const expected = process.env.DMD_INGEST_SECRET;
    if (!expected || secret?.trim() !== expected.trim()) {
      return res.status(401).json({ erro: 'nao autorizado' });
    }

    const body = req.body as DmdLeadBody;
    if (!body?.nome || !body?.whatsapp) {
      return res.status(422).json({ erro: 'dados incompletos' });
    }

    const supabase = getSupabaseAdmin();

    // normaliza telefone pro padrão E.164 usado no CRM
    let phone = String(body.whatsapp).replace(/\D/g, '');
    if (phone.length <= 11) phone = '55' + phone;
    phone = '+' + phone;

    const temperature = TEMPERATURA_CRM[body.temperatura] ?? 'Frio';
    const lida =
      body.resultado === 'nada'
        ? 'nada em ruína'
        : `falta ${NOME_EIXO[body.resultado] ?? body.resultado}`;
    const acompanhaTxt = body.acompanha
      ? `, com ${NOME_EIXO[body.acompanha] ?? body.acompanha} junto`
      : '';

    const observacao =
      `DMD ${body.temperatura.toUpperCase()} — ${lida}${acompanhaTxt}. ` +
      `Respondeu como ${body.perfil === 'ela' ? 'esposa' : 'marido'}. ` +
      new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .upsert(
        {
          org_id: ORG_ID,
          phone,
          name: body.nome,
          email: body.email || null,
          source: 'DMD',
          custom_fields: {
            observacao,
            instagram: body.instagram || null,
            origem_utm: body.origem || null,
          },
        },
        { onConflict: 'org_id,phone', ignoreDuplicates: false },
      )
      .select('id')
      .single();

    if (contactErr || !contact) {
      throw contactErr ?? new Error('contato não gravado');
    }

    // tag "Lead"
    const { data: tag } = await supabase
      .from('tags')
      .select('id')
      .eq('org_id', ORG_ID)
      .eq('name', 'Lead')
      .maybeSingle();
    if (tag) {
      await supabase
        .from('contact_tags')
        .upsert(
          { contact_id: contact.id, tag_id: tag.id, org_id: ORG_ID },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        );
    }

    const { data: stage } = await supabase
      .from('stages')
      .select('id')
      .eq('pipeline_id', PIPELINE_ID)
      .eq('name', STAGE_NAME)
      .maybeSingle();

    const { error: dealErr } = await supabase.from('deals').insert({
      org_id: ORG_ID,
      contact_id: contact.id,
      pipeline_id: PIPELINE_ID,
      stage_id: stage?.id ?? null,
      title: `DMD · ${lida}`,
      temperature,
      status: 'open',
      utm_source: body.origem?.utm_source || null,
      utm_medium: body.origem?.utm_medium || null,
      utm_campaign: body.origem?.utm_campaign || null,
    });

    if (dealErr) throw dealErr;

    return res.status(200).json({ ok: true, contact_id: contact.id });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err instanceof Error ? err.message : 'erro interno',
    });
  }
}
