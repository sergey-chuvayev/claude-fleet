// The approvals feature's public surface. Any managed session's pending approvals, the
// project manager's included: <Approvals managedId={id} approvals={readControlFields(session).approvals ?? []} />.
export { Approvals, type ApprovalsProps, questionsOf } from './Approvals'
