Date.now = () => 1_700_000_000_000;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, q]) => [id, { choice: Object.keys(q.criteria)[0] }]),
  );
  if (body.questions.provider?.criteria.codex) answers.provider.choice = "codex";
  for (const [id, key] of [
    ["kind", "FIXTURE_JEV_KIND"],
    ["stack", "FIXTURE_JEV_STACK"],
    ["collaboration", "FIXTURE_JEV_TEAM"],
    ["scope", "FIXTURE_JEV_SCOPE"],
  ]) {
    if (body.questions[id] && process.env[key]) answers[id] = { choice: process.env[key] };
  }
  return {
    ok: true,
    json: async () => ({
      model: "fixture-jev",
      answers,
    }),
  };
};
