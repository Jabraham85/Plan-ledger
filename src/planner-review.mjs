// Shared review vocabulary for the trusted Store and planner packet builder.
export const REVISION_ATTEMPT = '[planner] QA requested revision';

export function normalizeRevisionFeedback(feedback, contract) {
  const ids = new Set(contract.criteria.map(criterion => criterion.id));
  if (!Array.isArray(feedback) || !feedback.length || feedback.length > ids.size) throw new Error('planner_qa_invalid:feedback');
  return feedback.map(item => {
    if (!ids.delete(item?.criterion_id)) throw new Error('planner_qa_invalid:criterion_id');
    return {
      criterion_id: item.criterion_id,
      observation: reviewText(item.observation, 'observation'),
      next_action: reviewText(item.next_action, 'next_action'),
    };
  });
}

export function reviewText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error(`planner_qa_invalid:${field}`);
  return value.trim();
}
