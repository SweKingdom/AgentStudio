Task tracker — requirements

1. Background
The team tracks its work in a shared spreadsheet. Rows get overwritten and nobody knows what is overdue. We want a small task tracker with an API that the team's web page will use.

2. Tasks
2.1 Create and change tasks
- Team members must be able to create a task with a title and an optional due date.
- Team members must be able to change a task's title, due date and status (Open, In progress, Done).
- A task without a title must be rejected with a clear error message.
- Team members should be able to delete a task they own.

2.2 Find tasks
- Team members must be able to filter the task list by status.
- The task list should be sorted by due date, with tasks without a due date last.
- Team members can search tasks by a word in the title.

3. Team view
- Team leads should see a report of open and overdue tasks per team member.

4. Access
- Members may only delete their own tasks.
