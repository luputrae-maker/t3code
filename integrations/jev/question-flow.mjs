export function beginQuestion(request) {
  return { request, index: 0, answers: {} };
}
export function questionPrompt(flow) {
  const q = flow.request.questions[flow.index];
  const options = (q.options ?? [])
    .map((o, i) => `${i + 1}. ${o.label}${o.description ? " — " + o.description : ""}`)
    .join("\n");
  return `**${flow.request.title} needs your answer**\n\n${q.question}\n\n${options}${options ? "\n\n" : ""}Reply here${q.multiSelect ? " with one or more option numbers" : ""}.\n\n`;
}
export function answerQuestion(flow, text) {
  const q = flow.request.questions[flow.index],
    options = q.options ?? [];
  const raw = text.trim();
  if (!raw) return { error: "Please enter an answer." };
  let answers;
  if (q.multiSelect && /^\d+(?:\s*,\s*\d+)*$/.test(raw)) {
    const selected = raw.split(",").map((x) => options[Number(x.trim()) - 1]);
    if (selected.some((x) => !x)) return { error: "Choose the option numbers shown above." };
    answers = selected.map((o) => o.value ?? o.label);
  } else {
    const selected = /^\d+$/.test(raw)
      ? options[Number(raw) - 1]
      : options.find((o) => o.label.toLowerCase() === raw.toLowerCase() || o.value === raw);
    if (selected) answers = [selected.value ?? selected.label];
    else if (q.allowCustomAnswer === false && options.length)
      return { error: "Choose one of the options above." };
    else answers = [raw];
  }
  const next = {
    ...flow,
    index: flow.index + 1,
    answers: { ...flow.answers, [q.id]: { answers } },
  };
  return { flow: next, done: next.index >= flow.request.questions.length };
}
