/** Build switches are independent; no production authentication or writes by default. */
export function releaseFlags(
  development: boolean,
  auth?: string,
  editing?: string,
  submission?: string,
) {
  const authentication = development || auth === 'true';
  const authenticatedEditing = authentication && editing === 'true';
  return {
    authentication,
    authenticatedEditing,
    submission: authenticatedEditing && submission === 'true',
    localEditing: development && !authenticatedEditing,
  };
}
