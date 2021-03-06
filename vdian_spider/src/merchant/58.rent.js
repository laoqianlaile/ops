var fs = require('fs')
var Crawler = require('node-webcrawler')
var mysql = require('mysql')
var godotTransport = require("winston-godot")
var godot = require("godot")
var crypto = require('crypto')
var seenreq = require("seenreq")
var logger = require("winston")
var moment = require("moment")
var env = process.env.NODE_ENV || "development";
var config = require('../../config.json')[env].db;

var EventEmitter = require('events').EventEmitter
var e = new EventEmitter();

logger.add(logger.transports.File, { filename: '../../log/58.rent.log' ,logstash:true,level:'info',handleExceptions:true});
if(env === 'production'){
    logger.remove(logger.transports.Console);
}

var godotServer = require("../../config.json")[env].godotServer;
var client = godot.createClient(godotServer);
client.connect(godotServer.port);
logger.add(godotTransport, {godot:client, service:"58.rent"});

function Rent() {
    this.dataDir = '../../appdata/';
    //this.resultDir = '../../result/58/';
    this.cities = [];
    this.cityFile = "58.regions.txt";
    this.pagePerTask = 70;
    this.records = [];
    this.counter = 0;
    this.factor = 0.06;
    this.seen = new seenreq();
    this.endTask = false;
    this.initDatabase();
    this.t = null;
    
    this.c = new Crawler({
	maxConnections:1,
	rateLimits:3000,
	debug:env==='development',
	callback:function(err,result,$){
	    if(err){
		logger.error(err.message);
		e.emit('job-page');
	    }else{
		that.processList(result,$);
	    }
	},
	userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.111 Safari/537.36"
    });
    e.on("job-done",function(){
	that.start();
    });
    
    e.on("db-data",function(rows,fields){
	that.onDbData(rows,fields);
    });
    
    e.on("job-page",function(){
	logger.info("New records : %d",that.records.length);
	if(that.records.length>0){
	    that.conn.query("INSERT INTO `ClassifiedsPosts` (`mid`,`mname`,`murl`,`mq`,`city`,`district`,`primary`,`secondary`,`tertius`,`turl`,`tt`,`tid`,`site`,`createdAt`,`updatedAt`) VALUES ?",[that.records],function(err){
		if(err) logger.error(err);
	    });
	}
	var t = that.t;
	that.endTask = that.endTask || that.memberRate > that.records.length;
	if (that.endTask) {
            logger.info("less info,Category: %s",t.regionName);
	    process.nextTick(function(){that.wgetList();});
	} else if (!that.lastPage && t.pn < that.pagePerTask) {
            t.pn++;
	    process.nextTick(function(){that.wgetList(t);});
	} else {
            logger.info("Category: %s",t.regionName);
	    process.nextTick(function(){that.wgetList();});
	}
    });
}

Rent.prototype.onDbData = function(rows,fields){
    //logger.info(rows);
    if(rows && rows.length && rows[0].exists === 1){
	for(var i = 0;i<this.records.length;i++){
	    if(this.records[i][11]===rows[0].tid){
		this.records.splice(i,1);
		break;
	    }
	}
    }
    
    //how to figure out whether the work should stop? define a factor that is the ratio of same tid num per page.
    if(this.counter === 0){
	e.emit("job-page");
    }
}

Rent.prototype.initDatabase = function(){
    this.conn = mysql.createPool(config);
}

Rent.prototype.init = function(){
    this.cities = JSON.parse(fs.readFileSync(this.dataDir+this.cityFile).toString());
    this.tasks = [];
    for(var i=0; i< this.cities.length;i++){
	if (i > 0) break;
	var city = this.cities[i];
	var tmp = {"cityName":city.cname,"cityPinyin":city.cen,"districtName":"全部","regionName":"全部","category":city.cname,"class":'1'};
	this.tasks.push(tmp);
        for(var j=0;j<city.districts.length;j++){
            var district = city.districts[j];
            var tmp = {"cityName":city.cname,"cityPinyin":city.cen,"districtName":district.name,"districtPinyin":district.pinyin,"regionName":"全部","category":district.name,"class":'2'};
            this.tasks.push(tmp);
            if(district.regions.length!=0){
                for(var k=0;k<district.regions.length;k++){
                    var region = district.regions[k];
                    var tmp = {"cityName":city.cname,"cityPinyin":city.cen,"districtName":district.name,"districtPinyin":district.pinyin,"regionName":region.name,"regionPinyin":region.pinyin,"category":region.name,'class':'3'};
                    this.tasks.push(tmp);
                }
            }
        }
/*
	var city = this.cities[i];
	for(var j=0;j<city.districts.length;j++){
	        var district = city.districts[j];
	        if(district.regions.length==0){
		    var tmp = {"cityName":city.cname,"cityPinyin":city.cen,"districtName":district.name,"districtPinyin":district.pinyin};
		    this.tasks.push(tmp);
		    //var r = Object.keys(tmp).map(function(k){return tmp[k];}).join('\t');
		    //fs.appendFileSync(this.resultDir+"tasksout.txt",r+'\n');
		        }else{
			    for(var k=0;k<district.regions.length;k++){
				    var region = district.regions[k];
				    var tmp = {"cityName":city.cname,"cityPinyin":city.cen,"districtName":district.name,"districtPinyin":district.pinyin,"regionName":region.name,"regionPinyin":region.pinyin}
				    this.tasks.push(tmp);
				//var r = Object.keys(tmp).map(function(k){return tmp[k];}).join('\t');
				//    fs.appendFileSync(this.resultDir+"tasksout.txt",r+'\n');
				}
			        }
	    }
*/
    }

    var arguments = process.argv.splice(2);
    var start = Number(arguments[0]) || 0;
    var len = Number(arguments[1]) || this.tasks.length;
    //前闭后开区间
    this.tasks = this.tasks.slice(start,start+len);
    logger.log("task count: %d",this.tasks.length);
}

Rent.prototype.start = function(){
    logger.info("Starting job...");
    this.init();
    this.wgetList();
}

Rent.prototype.wgetList = function(t){
    if(!t){
	if(this.tasks.length==0){
	    logger.log("job done.");
	    e.emit("job-done");
	    return;
	}
	t = this.tasks.shift();
	t.pn = 1;
	logger.log("task left: %d",this.tasks.length);
    }
    var path = "/";
    if(t.class == '3') {
	path += t.regionPinyin+"/";
    } else if(t.class == '2') {
        path += t.districtPinyin+"/";
    }
    var opt = Object.create(null);
    opt.t = t;
    opt.uri = ["http://",t.cityPinyin,".58.com",path,"chuzu/pn",t.pn,"/"].join("");
    this.t = t;
    this.memberRate = 0;
    this.records = [];
    this.lastPage = false;
    this.c.queue(opt);
    logger.info("%s, %s, %s, %d",t.cityName,t.districtName,t.regionName,t.pn);
}

Rent.prototype.processList = function(result,$){
    if(!$){
	e.emit("job-page");
	return;
    }
    
    var t = this.t
    ,timeRegexp = /(今天|小时|分钟)/
	, merchantRegexp = /\/(\d+)\/$/
	, memberCount = 0
    , len = $("div#infolist > table.tbimg tr").length
    , freeCount=0
    , topCount=0
    , hotCount=0
    , curPage = $(".pager strong").text().trim();
    this.lastPage = $('.pager').length === 0;
    
    $("div#infolist > table.tbimg tr").each(function(){
        if($(this).text().indexOf("以上本地信息更新较少") >= 0) {
            that.endTask = true;
            return false;
        }
	
        var td = $("td.t",this)
        , turl = $("h1 a.t",td).attr("href")
        , member = $("h1 span.wlt-ico",td).length
        , jing = $("h1 span.jingpin",td).length
	, fn = crypto.createHash("md5")
        , top1 = $("h1 span.ico.ding",td).length
	, top2 = 0
        , addr = $("p.qj-renaddr",td).text().trim().replace(/[\s]/g,"").replace(/[,，]/g,";")
        , addrInfos = addr.split("/")
	, mid = null
	, jjrLine = $("p.qj-rendp span.qj-listjjr",td)
	, mname = $("a",jjrLine).text().replace(/[,\s]/,'')
	, murl = $("a.qj-lijjrname",jjrLine).attr("href")
	, tt = member + (jing << 1) + (top2 << 2) + (top1 << 3)
        , houseName,pubDate;
	
	memberCount += member;
	if(tt===0){
	    ++freeCount;
	    return;
	}
	topCount += top1+top2;
	hotCount += jing;
	
        if(addrInfos.length>0)
            houseName = addrInfos[0].trim();
        if(addrInfos.length>1)
            pubDate = addrInfos[1].trim();
	
	if(murl && merchantRegexp.test(murl)){
	    mid = murl.match(merchantRegexp)[2];
	}
	
	that.endTask = !timeRegexp.test(pubDate);
	fn.update(that.seen.normalize(turl));
	var tid = fn.digest("hex");
	//logger.info("%s\n%s",turl,tid);
	var record = [mid,mname,murl,0,t.cityName,t.regionName,"租房",t.districtName,t.regionName,turl,tt,tid,'58',new Date(),new Date()];
	that.records.push(record);
	++that.counter;
	that.conn.query("SELECT ? AS `tid`, (CASE WHEN EXISTS (SELECT * FROM `ClassifiedsPosts` WHERE `ClassifiedsPosts`.`tid`=? AND tt=? AND updatedAt > ?) THEN 1 ELSE 0 END) AS `exists` ",[tid,tid,tt,moment().format("YYYY-MM-DD")],function(err,rows,fields){
	    if(err) logger.error(err);
	    --that.counter;
	    e.emit("db-data",rows,fields);
	});
    });
    
    delete result.body;
    $ = null;
    
    logger.info("Page: %s, Free/Paid/Total: %d/%d/%d, Hot/Top/Member: %d/%d/%d",curPage,freeCount,this.records.length,len,hotCount,topCount,memberCount);
    this.endTask = this.endTask || len < 10 || memberCount<4;
    this.memberRate = this.factor * len;

    if(this.records.length===0){
	e.emit("job-page");
    }
}

var instance = new Rent();
var that = instance;
that.start();
