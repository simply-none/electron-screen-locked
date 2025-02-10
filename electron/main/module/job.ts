import { CronJob } from 'cron';
import momemt from 'moment';

let job

export function createJob({ win, time = 5 * 60 * 1000, onTick = () => {},  msgName = 'tip-job' }) {
	if (job) {
		job.stop();
		job = null;
	}
	let jobTime = time
	if (jobTime < 5 * 60 * 60) jobTime = 5 * 60 * 60;

	const currentSecondTime = new Date().getSeconds();
	const currentMinuteTime = new Date().getMinutes();
	console.log(currentSecondTime, jobTime);
	const nextRunTime = momemt().add(jobTime, 'milliseconds').toDate()

	job = new CronJob(
		nextRunTime, // cronTime
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
