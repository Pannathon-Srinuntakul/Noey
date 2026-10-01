import { startTransition, type FormEvent } from "react";

/**
 * A form's onSubmit that runs its useActionState action without React's
 * automatic reset afterwards.
 *
 * A form whose `action` is a function is cleared by React once the action
 * returns — on an error too: the password the visitor typed is wiped, and a
 * checkbox bound to the form with `form=` (the sign-up consent box) is
 * unticked while the state that unlocks the buttons still says it is ticked.
 * Calling the action here, inside a transition, after preventing the submit,
 * keeps every field as it was. The form keeps its `action` prop, so without
 * JavaScript it still posts to the Server Action.
 */
export function submitKeepingValues(action: (data: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    startTransition(() => action(data));
  };
}
