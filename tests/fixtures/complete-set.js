export const templates = [
  {id:'sportsContestResult',role:'question',keywords:['competition','contestType','countedPlay','officialSource','participantA','participantB','resolutionDeadline','scheduledStart','sport'].map(k=>[k,'string']),description:'Exactly one corresponding named outcome resolves to Yes; the other two and the fallback resolve to No. Draw also resolves to Yes if the Contest Result records a no contest or no winner, names an unlisted winner, or is not established by {resolutionDeadline} UTC (the "Residual Conditions").'},
  {id:'sportsContestParticipant2',role:{questionOutcome:{parent:'sportsContestResult'}},keywords:[['participant','string']],description:'This outcome resolves to Yes if {participant} is the sole winner of the Contest under the parent question rules, and otherwise resolves to No.'},
  {id:'sportsContestDraw2',role:{questionOutcome:{parent:'sportsContestResult'}},keywords:[],description:'This outcome resolves to Yes if, under the parent question rules, the Contest Result is a draw or the Residual Conditions apply, and otherwise resolves to No.'},
];
export const q={question:325,name:'template:sportsContestResult',description:'competition:UEFA Nations League|contestType:Match|countedPlay:regulation time, 90 minutes plus stoppage time|officialSource:Union of European Football Associations|participantA:Czechia|participantB:Croatia|scheduledStart:20260926-1845|resolutionDeadline:20260927-1845|sport:Soccer',namedOutcomes:[4483,4484,4485],fallbackOutcome:4482,settledNamedOutcomes:[]};
export const outcomes=[
  {outcome:4483,name:'template:sportsContestParticipant2',description:'participant:Czechia',quoteToken:'USDC',deployerFeeScale:'1'},
  {outcome:4484,name:'template:sportsContestDraw2',description:'',quoteToken:'USDC',deployerFeeScale:'1'},
  {outcome:4485,name:'template:sportsContestParticipant2',description:'participant:Croatia',quoteToken:'USDC',deployerFeeScale:'1'},
  {outcome:4482,name:'template fallback',description:'other',quoteToken:'USDC',deployerFeeScale:'1'},
].map(o=>({...o,sideSpecs:[{name:'Yes'},{name:'No'}]}));
export const meta={questions:[q],outcomes};
export const fees={userSpotCrossRate:'0.0007',feeSchedule:{spotCross:'0.0007'}};
export const account='0x'+'1'.repeat(40);
export const fixedNow=Date.parse('2026-09-23T15:00:00Z');
