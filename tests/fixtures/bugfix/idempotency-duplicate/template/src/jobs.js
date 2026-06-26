let counter = 0;
const jobs = [];

function submitJob(taskKey) {
  const job = { id: `job-${counter}`, taskKey };
  counter += 1;
  jobs.push(job);
  return job;
}

module.exports = { submitJob };
