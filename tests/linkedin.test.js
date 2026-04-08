const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLinkedinLeads,
  createLinkedinJobManager,
  scoreInviteActionLabel,
  pickBestInviteAction,
  inferTopCardRelationship
} = require('../src/linkedinAutomation');

test('buildLinkedinLeads extracts linkedin urls and normalized placeholders', () => {
  const leads = buildLinkedinLeads([
    {
      'First Name': 'Ava',
      'Last Name': 'Stone',
      'Company Name': 'Acme',
      'Person Linkedin Url': 'https://www.linkedin.com/in/ava-stone/'
    },
    {
      'First Name': 'No Url',
      Email: 'nou@example.com'
    }
  ]);

  assert.equal(leads.length, 1);
  assert.equal(leads[0].linkedin_url, 'https://www.linkedin.com/in/ava-stone/');
  assert.equal(leads[0].receiver_name, 'Ava Stone');
  assert.equal(leads[0].company_name, 'Acme');
});

test('createLinkedinJobManager tracks result counters', () => {
  const jobs = createLinkedinJobManager();
  const job = jobs.createJob({ total: 3, logFile: '/tmp/test.jsonl' });

  jobs.appendResult(job.id, { status: 'connect_sent' });
  jobs.appendResult(job.id, { status: 'skipped' });
  jobs.appendResult(job.id, { status: 'failed' });
  jobs.finishJob(job.id);

  const finalJob = jobs.getJob(job.id);
  assert.equal(finalJob.processed, 3);
  assert.equal(finalJob.sentConnectRequests, 1);
  assert.equal(finalJob.skipped, 1);
  assert.equal(finalJob.failed, 1);
  assert.equal(finalJob.status, 'completed');
});

test('scoreInviteActionLabel prioritizes send/invite actions', () => {
  assert.equal(scoreInviteActionLabel('Send without a note'), 120);
  assert.equal(scoreInviteActionLabel('Send invitation'), 110);
  assert.equal(scoreInviteActionLabel('Send'), 100);
  assert.equal(scoreInviteActionLabel('Cancel'), -100);
});

test('pickBestInviteAction chooses best actionable button', () => {
  const best = pickBestInviteAction([
    { label: 'Cancel', index: 0 },
    { label: 'Add a note', index: 1 },
    { label: 'Send without a note', index: 2 }
  ]);

  assert.equal(best.index, 2);
  assert.equal(best.score, 120);
});

test('inferTopCardRelationship marks Follow+Message profile as not existing connection', () => {
  const relationship = inferTopCardRelationship({
    actions: [
      { label: 'Message', text: 'Message', aria: '' },
      { label: 'Follow Kris Yang', text: 'Follow', aria: 'Follow Kris Yang' },
      { label: 'More', text: '', aria: 'More' }
    ]
  }, 'Kris Yang');

  assert.equal(relationship.hasFollowCta, true);
  assert.equal(relationship.likelyFirstDegree, false);
});

test('inferTopCardRelationship marks Following profile as existing connection', () => {
  const relationship = inferTopCardRelationship({
    actions: [
      { label: 'Message', text: 'Message', aria: '' },
      { label: 'Following, click to unfollow Aqsa Akber', text: 'Following', aria: 'Following, click to unfollow Aqsa Akber' }
    ]
  }, 'Aqsa Akber');

  assert.equal(relationship.hasFollowingCta, true);
  assert.equal(relationship.likelyFirstDegree, true);
});
