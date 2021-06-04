const schedule = require('node-schedule');
const process = require("process")
const dateFormat = require('dateformat')
const SSH2Promise = require('ssh2-promise')
const fs = require("fs")
const ini = require("ini")
const md5File = require('md5-file')

let cfg = {}
let cfgFile = 'backup.ini'
let cfgTemplate = {
    schedule: {
        cronFormat: "",
        hour: 5,
        minute: 0,
        date: [],
        month: [],
        dayOfWeek: [],
        tz: "Etc/UTC"
    },
    queue: {
        limit: 3
    }
}

function formatStr() {
    if(arguments.length) {
        let num = 0;
        let args = arguments;
        return arguments[0].replace(/%s/g, function(){ return args[++num]; });
    } return "";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const status = {
    error:   0,
    launch:  1,    
    success: 2
}

class backup {
    status = {
        code: status.launch,
        exception: {}
    }
    identifier = ''

    constructor(sshConfig, identifier) {       
        this.identifier = identifier || sshConfig.host
        let ssh = new SSH2Promise(sshConfig)
        ssh.connect().then(async () => {
            try {
                await ssh.exec("system backup save dont-encrypt=yes name=backup")
                await ssh.exec("export compact file=backup")
                await sleep(2000)
            
                let fname = dateFormat(new Date(), "yy.mm.dd_hh.MM.ss")
                let dst = formatStr("backup/%s", this.identifier)
                if (!fs.existsSync(dst)) fs.mkdirSync(dst)

                let sftp = ssh.sftp()
                await sftp.fastGet("backup.rsc",    formatStr("%s/%s.rsc",    dst, fname))
                await sftp.fastGet("backup.backup", formatStr("%s/%s.backup", dst, fname))
            } catch (exception) {
                this.#setStatus(status.error, exception)
            } finally {
                this.#setStatus(status.success)

                await ssh.exec("file remove backup.rsc")
                await ssh.exec("file remove backup.backup")
                
                ssh.close()
            }
        }).catch((exception) => {
            this.#setStatus(status.error, exception)
        }).finally(() => {

        })
    }

    #setStatus(code, exception) {
        if (this.status.code === status.launch) {
            this.status.code = code
            if (!!exception) {
                this.status.exception = exception
            }
        }
    }
}

async function coincidenceControl(id) {
    try {
        let list = fs.readdirSync("backup/" + id)
        let size = Object.keys(list).length
        let hash = {
            backup: [],
            rsc: []
        }
        if (size) {
            for (i = size - 1; i >= 0; i--) {
                finfo = list[i].match(/\.(backup|rsc)$/i)
                if (finfo && hash[finfo[1]].length < 2) {
                    hash[finfo[1]].push({
                        file: list[i],
                        hash: md5File.sync(formatStr("backup/%s/%s", id, list[i]))
                    })
                }
                if (hash.backup.length >= 2 && hash.rsc.length >= 2) {
                    if (hash.backup[0] === hash.backup[1]) { /* delete last backup file */ }
                    if (hash.rsc[0] === hash.rsc[1]) { /* delete last backup file */ }
                    //console.log(hash)
                    //console.log(list)
                    break
                }
            }
        }
    } catch (exception) {
        console.log("Ошибка в ходе поиска дубликатов в последних бэкапах для ", id)
        console.log(exception)
    }
}

async function distributor(list) {
    let queue = {}
    let limit = cfgTemplate.queue.limit || 3
    while (Object.keys(list).length || Object.keys(queue).length) {
        if (Object.keys(queue).length) {
            for (const [id, worker] of Object.entries(queue)) {
                switch (worker.status.code) {
                    case status.launch: continue
                    case status.error:
                            console.log(formatStr("Ошибка в ходе выполнения бэкапа для профиля %s", id))
                            console.log(worker.status.exception)
                            delete queue[id]
                        break
                    case status.success:
                            console.log(formatStr("Успешно выполнен бэкап для профиля %s", id))
                            delete queue[id]
                            //coincidenceControl(id)
                        break
                    default:
                            console.log(formatStr("Неизвестный код статуса \"%s\" для профиля %s", worker.status.code, id))
                            delete queue[id]
                }
            }
        }
        if (Object.keys(queue).length < limit && Object.keys(list).length) {
            for (const [id, cfg] of Object.entries(list)) {
                console.log(formatStr("Новая задая для профиля %s", id))
                queue[id] = new backup(cfg, id)
                delete list[id]
                if (Object.keys(queue).length >= limit) {
                    break
                }
            }
        }
        await sleep(500)
    }
}

async function handler(){
    let pathConf = "config"
    let pathKeys = "keys"
    let list = {}
    let contents = {}
    if (fs.existsSync(pathConf)) {
        try {
            contents = fs.readdirSync(pathConf)
        } catch (exception) {
            console.log(exception)
            process.exit()
        }
        for (const [num, obj] of Object.entries(contents)) {
            try {
                let tid = obj.match(/^([^/]+)\.ini$/)
                if (tid && fs.lstatSync(pathConf + "/" + obj).isFile()) {
                    let cfgTemplate = {
                        host: '',
                        port: 22,
                        username: '',
                        password: '',
                        identity: ''
                    }
                    let cfg = ini.parse(fs.readFileSync(pathConf + "/" + obj, "utf-8"))
                    if (cfg) {
                        for (const [param, value] of Object.entries(cfgTemplate)) {
                            if (!!cfg[param] && cfg[param].length) {
                                cfgTemplate[param] = (param !== 'identity') ? cfg[param] : formatStr("%s/%s", pathKeys, cfg[param])
                            }
                        }
                        if (!cfgTemplate.host.length || !cfgTemplate.username.length) {
                            console.log(formatStr("Файл конфигурации %s не содержит информацию достаточную для подключения и авторизации", obj))
                            continue
                        }
                        list[tid[1]] = cfgTemplate
                    }
                }
            } catch (exception) {
                console.log(exception)
            }
        }
        distributor(list)
    } else {
        console.log("Ошибка чтения каталога с конфигами")
        process.exit()
    }    
}

try {
    if (fs.existsSync(cfgFile)) {
        cfg = ini.parse(fs.readFileSync(cfgFile, "utf-8"));
    }
} catch (exception) {
    console.log("Ошибка чтения файла конфигурации ", cfgFile)
    console.log(exception)
    process.exit()
}

for (const [section, s] of Object.entries(cfgTemplate)) {
    for (const [param, value] of Object.entries(s)) {
        if (!!cfg[section] && !!cfg[section][param]) {
            if (cfgTemplate[section][param] !== '') {
                cfgTemplate[section][param] = cfg[section][param]
            }
        } else {
            if (section !== 'queue') {
                delete cfgTemplate[section][param]
            }
        }
    }
}

try {
    if (!!cfgTemplate.schedule.cronFormat) {
        schedule.scheduleJob(cfgTemplate.schedule.cronFormat, handler)
    } else {
        delete cfgTemplate.schedule.cronFormat
        const rule = new schedule.RecurrenceRule()
        for (const [param, value] of Object.entries(cfgTemplate["schedule"])) {
            rule[param] = value
        }
        schedule.scheduleJob(rule, handler);
    }
    console.log(dateFormat(new Date(), "yy.mm.dd_hh.MM.ss"))
    console.log(cfgTemplate)
} catch (exception) {
    console.log("Ошибка постановки задачи в планировщик")
    console.log(exception)
    process.exit()
}