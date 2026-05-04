const fs = require('fs');

const oeData = JSON.parse(fs.readFileSync('dist/oe_national_2024.json', 'utf8'));

fs.mkdirSync('data/lookups', {recursive: true});
fs.mkdirSync('dist/lookups', {recursive: true});

function save(name, data) {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync('data/lookups/' + name, json);
  fs.writeFileSync('dist/lookups/' + name, json);
  console.log(name + ': ' + data.length + ' entries, ' + json.length + ' bytes');
}

// 1. surveys
save('surveys.json', [
  {survey_code:'OE', name:'Occupational Employment and Wage Statistics', short_name:'OEWS', frequency:'Annual', length:25, description:'Occupation x Industry x Area wages and employment.'},
  {survey_code:'CE', name:'Current Employment Statistics', short_name:'CES', frequency:'Monthly', length:13, description:'Employment, hours, and earnings by industry supersector.'},
  {survey_code:'LN', name:'Labor Force Statistics (CPS)', short_name:'CPS/LN', frequency:'Monthly', length:11, description:'Labor force, employment, unemployment by demographics.'}
]);

// 2. OE area types
save('oe_areatypes.json', [
  {code:'N', label:'National'},
  {code:'S', label:'State'},
  {code:'M', label:'Metropolitan Statistical Area'},
  {code:'B', label:'Metropolitan Division'},
  {code:'D', label:'Department of Defense'}
]);

// 3. OE areas
var stateData = [
  ['01','Alabama'],['02','Alaska'],['04','Arizona'],['05','Arkansas'],['06','California'],
  ['08','Colorado'],['09','Connecticut'],['10','Delaware'],['11','District of Columbia'],['12','Florida'],
  ['13','Georgia'],['15','Hawaii'],['16','Idaho'],['17','Illinois'],['18','Indiana'],
  ['19','Iowa'],['20','Kansas'],['21','Kentucky'],['22','Louisiana'],['23','Maine'],
  ['24','Maryland'],['25','Massachusetts'],['26','Michigan'],['27','Minnesota'],['28','Mississippi'],
  ['29','Missouri'],['30','Montana'],['31','Nebraska'],['32','Nevada'],['33','New Hampshire'],
  ['34','New Jersey'],['35','New Mexico'],['36','New York'],['37','North Carolina'],['38','North Dakota'],
  ['39','Ohio'],['40','Oklahoma'],['41','Oregon'],['42','Pennsylvania'],['44','Rhode Island'],
  ['45','South Carolina'],['46','South Dakota'],['47','Tennessee'],['48','Texas'],['49','Utah'],
  ['50','Vermont'],['51','Virginia'],['53','Washington'],['54','West Virginia'],['55','Wisconsin'],
  ['56','Wyoming'],['66','Guam'],['72','Puerto Rico'],['78','Virgin Islands']
];
var oe_areas = [{area_type:'N', area_code:'0000000', area_name:'National'}];
stateData.forEach(function(s) { oe_areas.push({area_type:'S', area_code: s[0] + '00000', area_name: s[1]}); });
save('oe_areas.json', oe_areas);

// 4. OE industries
save('oe_industries.json', [
  {industry_code:'000000', industry_name:'Cross-industry, all industries'},
  {industry_code:'110000', industry_name:'Agriculture, Forestry, Fishing, and Hunting'},
  {industry_code:'210000', industry_name:'Mining, Quarrying, and Oil and Gas Extraction'},
  {industry_code:'220000', industry_name:'Utilities'},
  {industry_code:'230000', industry_name:'Construction'},
  {industry_code:'310000', industry_name:'Manufacturing'},
  {industry_code:'420000', industry_name:'Wholesale Trade'},
  {industry_code:'440000', industry_name:'Retail Trade'},
  {industry_code:'480000', industry_name:'Transportation and Warehousing'},
  {industry_code:'510000', industry_name:'Information'},
  {industry_code:'520000', industry_name:'Finance and Insurance'},
  {industry_code:'530000', industry_name:'Real Estate and Rental and Leasing'},
  {industry_code:'540000', industry_name:'Professional, Scientific, and Technical Services'},
  {industry_code:'550000', industry_name:'Management of Companies and Enterprises'},
  {industry_code:'560000', industry_name:'Administrative and Support Services'},
  {industry_code:'610000', industry_name:'Educational Services'},
  {industry_code:'620000', industry_name:'Health Care and Social Assistance'},
  {industry_code:'710000', industry_name:'Arts, Entertainment, and Recreation'},
  {industry_code:'720000', industry_name:'Accommodation and Food Services'},
  {industry_code:'810000', industry_name:'Other Services (except Public Administration)'},
  {industry_code:'920000', industry_name:'Public Administration'},
  {industry_code:'999000', industry_name:'Federal, State, and Local Government'},
  {industry_code:'999100', industry_name:'Federal Government'},
  {industry_code:'999200', industry_name:'State Government'},
  {industry_code:'999300', industry_name:'Local Government'}
]);

// 5. OE occupations — extract ALL from oe_national_2024.json
var oe_occupations = oeData.occupations.map(function(o) {
  return {occ_code: o.occ_code, soc_6digit: o.occ_code_nodash, occ_title: o.occ_title, occ_group: o.o_group};
});
save('oe_occupations.json', oe_occupations);

// 6. OE datatypes
save('oe_datatypes.json', [
  {code:'01', label:'Total employment'},
  {code:'02', label:'Employment RSE'},
  {code:'03', label:'Mean hourly wage'},
  {code:'04', label:'Mean annual wage'},
  {code:'05', label:'Mean wage RSE'},
  {code:'06', label:'10th percentile hourly wage'},
  {code:'07', label:'25th percentile hourly wage'},
  {code:'08', label:'Median hourly wage'},
  {code:'09', label:'75th percentile hourly wage'},
  {code:'10', label:'90th percentile hourly wage'},
  {code:'11', label:'10th percentile annual wage'},
  {code:'12', label:'25th percentile annual wage'},
  {code:'13', label:'Median annual wage'},
  {code:'14', label:'75th percentile annual wage'},
  {code:'15', label:'90th percentile annual wage'}
]);

// 7. CE industries (supersector codes)
save('ce_industries.json', [
  {supersector:'00', industry_code:'000000', label:'Total nonfarm'},
  {supersector:'05', industry_code:'000000', label:'Total private'},
  {supersector:'06', industry_code:'000000', label:'Goods-producing'},
  {supersector:'07', industry_code:'000000', label:'Service-providing'},
  {supersector:'08', industry_code:'000000', label:'Private service-providing'},
  {supersector:'10', industry_code:'000000', label:'Mining and logging'},
  {supersector:'20', industry_code:'000000', label:'Construction'},
  {supersector:'30', industry_code:'000000', label:'Manufacturing'},
  {supersector:'31', industry_code:'000000', label:'Durable goods'},
  {supersector:'32', industry_code:'000000', label:'Non-durable goods'},
  {supersector:'40', industry_code:'000000', label:'Trade, transportation, and utilities'},
  {supersector:'41', industry_code:'000000', label:'Wholesale trade'},
  {supersector:'42', industry_code:'000000', label:'Retail trade'},
  {supersector:'43', industry_code:'000000', label:'Transportation and warehousing'},
  {supersector:'44', industry_code:'000000', label:'Utilities'},
  {supersector:'50', industry_code:'000000', label:'Information'},
  {supersector:'55', industry_code:'000000', label:'Financial activities'},
  {supersector:'60', industry_code:'000000', label:'Professional and business services'},
  {supersector:'65', industry_code:'000000', label:'Education and health services'},
  {supersector:'70', industry_code:'000000', label:'Leisure and hospitality'},
  {supersector:'80', industry_code:'000000', label:'Other services'},
  {supersector:'90', industry_code:'000000', label:'Government'}
]);

// 8. CE datatypes
save('ce_datatypes.json', [
  {code:'01', label:'All employees, thousands'},
  {code:'02', label:'Average weekly hours, all employees'},
  {code:'03', label:'Average hourly earnings, all employees'},
  {code:'04', label:'Average weekly earnings, all employees'},
  {code:'06', label:'Production and nonsupervisory employees, thousands'},
  {code:'08', label:'Average weekly hours, prod/nonsup'},
  {code:'09', label:'Average hourly earnings, prod/nonsup'},
  {code:'10', label:'Average weekly earnings, prod/nonsup'},
  {code:'11', label:'Average weekly overtime hours, all employees'},
  {code:'26', label:'Indexes of diffusion, 1-month span'}
]);

// 9. LN concepts — known-valid SA/NSA pairs
save('ln_concepts.json', [
  {code:'unemployment_rate',    label:'Unemployment rate',              sa:'LNS14000000', nsa:'LNU14000000', unit:'Percent'},
  {code:'unemployment_level',   label:'Unemployment level',             sa:'LNS13000000', nsa:'LNU13000000', unit:'Thousands'},
  {code:'employment_level',     label:'Employment level',               sa:'LNS12000000', nsa:'LNU12000000', unit:'Thousands'},
  {code:'civilian_labor_force', label:'Civilian labor force level',     sa:'LNS11000000', nsa:'LNU11000000', unit:'Thousands'},
  {code:'participation_rate',   label:'Labor force participation rate', sa:'LNS11300000', nsa:'LNU11300000', unit:'Percent'},
  {code:'emp_pop_ratio',        label:'Employment-population ratio',    sa:'LNS12300000', nsa:'LNU12300000', unit:'Percent'},
  {code:'not_in_labor_force',   label:'Not in labor force',             sa:'LNS15000000', nsa:'LNU15000000', unit:'Thousands'}
]);

// 10. LN demographics
save('ln_demographics.json', [
  {code:'0000', label:'Total, 16 years and over'},
  {code:'0100', label:'Men, 16 years and over'},
  {code:'0200', label:'Women, 16 years and over'},
  {code:'0300', label:'16 to 19 years'},
  {code:'0400', label:'20 years and over'},
  {code:'0500', label:'White'},
  {code:'0600', label:'Black or African American'},
  {code:'0700', label:'Asian'},
  {code:'0800', label:'Hispanic or Latino'},
  {code:'1000', label:'Less than a high school diploma'},
  {code:'1100', label:'High school graduates, no college'},
  {code:'1200', label:'Some college or associate degree'},
  {code:'1300', label:'Bachelors degree and higher'}
]);

console.log('\nDone.');
