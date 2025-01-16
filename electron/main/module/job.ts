import { CronJob } from 'cron';

let job

export function createJob({ win, time = 5 * 60 * 1000, onTick = () => {},  msgName = 'tip-job' }) {
	if (job) {
		job.stop();
		job = null;
	}
	const jobTime = Math.floor(time / 1000 / 60)

	const currentSecondTime = new Date().getSeconds();
	console.log(currentSecondTime, jobTime);
	job = new CronJob(
		`${currentSecondTime}  */${jobTime} * * * *`, // cronTime
		function () {
			onTick();
			win?.webContents.send(msgName, Date.now());
		}, // onTick
		null, // onComplete
		true, // start
		'America/Los_Angeles' // timeZone
	);
}

export function stopJob() {
	job.stop()
	job = null;
}

export default {
	createJob,
	stopJob,
};
