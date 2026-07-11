u/Grand-Vision avatar
Grand-Vision
•
3mo ago
This is a real gap in self-hosted n8n. The native execution log is fine for debugging individual runs but useless for understanding system health across workflows.

A few things I ended up building manually before something like this existed — worth sharing in case it helps others:

A simple "execution logger" workflow that every other workflow triggers on completion via a webhook. It logs: workflow name, execution time, status, trigger type, and a custom tag I pass in. Feeds into Airtable. Takes about 10 minutes to set up and suddenly you have a queryable history.

For error intelligence specifically, I added a standard error branch to every workflow that sends a Slack message containing the full $json of the failed node. When something breaks at 2am you want the payload that caused it, not just "workflow failed." That alone has cut my debugging time by probably 60%.

The ROI tracking piece is the hardest. Execution time is measurable. The actual value of "this automation ran" depends entirely on what it replaced, which is context you have to inject yourself. I have been doing it by tagging workflows with an estimated minutes-saved-per-run value and multiplying by execution count. Rough but defensible.

A purpose-built dashboard is the right approach. Manually querying execution logs gets old fast. What does your error detection logic look like — is it pattern-matching on error messages or something more structural?


Upvote
1

Downvote

Reply

Award

Share

u/Stunning_Penalty1081 avatar
Stunning_Penalty1081
OP
•
3mo ago
Hi,
Those are some of the exact reasons i built this app.
1. Execution Logger:
in the beggining, i had a similar node like "send to airtable" in the end of each workflow, however, i really wanted to avoid polluting my workflows with extra nodes. the data was there, i just needed to touch the DB in order to get them. Pros:

Zero Overhead: Since the dashboard pulls metadata directly from the n8n database into a local SQLite replica, you don't waste executions or resources on 'logging nodes.'

No Workflow Modification: You don't need to add 'on-error-continue' logic or complex error branches to every single workflow just to ensure a log is sent. It works retroactively on everything.

2. Error Intelligence & Raw Traces
I totally agree, the payload is what you really want. Apart from the distinction of Node that failed for each of the workflows, you can click on the error, and fetch the raw trace as well:

Comment Image
Yoy can download the data for each workflow in .csv, .json. Needs more work in order for it to be perfect, but we can do it.

3. ROI Tracking & The 'Wizard'
You actually nailed the ROI challenge. Multiplying by execution count is often misleading because a workflow that runs 1,000 times might only save 5 seconds per run, while a weekly 'heavy lifter' might save 4 hours of manual labor.
Human-Centric ROI: My approach uses a Wizard Calculator. Instead of just 'minutes per run,' it lets you define the actual manual time a human used to spend on that task per day/week/month. It treats automation as a resource replacement, not just a counter. It does the math for you!!
Tell the system how often humans used to perform this task (e.g. 5 times a week). The tool will intelligently fetch your n8n execution volume from the last 30 days to calculate a perfectly scaled "Seconds per Execution" logic ratio.

4. "is it pattern-matching on error messages or something more structural?"
The answer is: It can be both, and that’s where I’m heading.
Rightnow, what’s already implemented in the Error Intelligence page is primarily structural. The dashboard maps the 'Origin Nodes' and identifies 'Brittle Paths'—it essentially visualizes the failure distribution across your workflow’s architecture so you can see which specific node type or branch is causing the most friction.
However, the pattern-matching part is something I'm actively working on. The goal is to not just show where it failed, but to aggregate error messages across different workflows to identify common themes (e.g., catching a 'Rate Limit' issue that’s hitting five different services at once). It’s a work in progress, but the foundation is there to make it a dual-threat diagnostic tool!

I really tihnk this project is made for people like you, i'd love to see you trying it out, and providing me with more feedback!!


Upvote
1

Downvote

Reply

Award

Share

21

u/Grand-Vision avatar
Grand-Vision
•
2mo ago
The zero overhead approach is smart — pulling directly from the execution DB rather than instrumenting every workflow is exactly the right call. The Airtable logger I described works but it does add noise to the workflow graph and creates a dependency on an external service that can itself fail.

The bit I am most curious about is the error intelligence layer. Pattern matching on error messages is useful but what I have found is that the same error message can mean completely different things depending on what triggered the workflow and what the payload looked like. Does your dashboard capture the input data that caused the failure, or just the error type and node?

The other thing that is genuinely hard: distinguishing between transient errors (network timeout, rate limit) and structural errors (bad payload, broken credential). The first should auto-retry, the second needs human attention. Most logging setups treat them the same and you end up either drowning in noise or missing real breaks.

How are you handling that distinction?


Upvote
1

Downvote

Reply

Award

Share

u/Grand-Vision avatar
Grand-Vision
•
2mo ago
That's the right approach. What stack for the custom logger? Curious whether you went Postgres direct or something else.


Upvote
1

Downvote

Reply

Award

Share

u/Stunning_Penalty1081 avatar
Stunning_Penalty1081
OP
•
2mo ago
Hi, right now I’m on vacation that’s why I haven’t answered yet. I’ll get back to you as soon as I return back home. I’ll provide screenshots and code snippets in order to clarify everything!


Upvote
1

Downvote

Reply

Award

Share

3

u/Grand-Vision avatar
Grand-Vision
•
2mo ago
No rush at all, enjoy the holiday. Looking forward to seeing the screenshots when you are back.