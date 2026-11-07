In a task that has several branches, each separate pull request (the pull-request sub-tasks created from the task's branches) shows "Couldn't inspect ignored output. Retry" in its Review, every time.

A pull-request sub-task has no world of its own — its parent task keeps the world and whatever ignored files are in it. So for such a pull-request task the ignored-output inventory should just be empty instead of failing. Please fix it and add a test.
