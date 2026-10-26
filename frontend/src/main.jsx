import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ArrowDownRight, ArrowUpRight, CalendarDays, Check, ChevronDown, Clock3, Download, ExternalLink, Info, Leaf, LoaderCircle, RefreshCw, ShieldCheck, Wind, Zap } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import './styles.css'

const fmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const oneDec = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })
const initialMonth = '2026-01'

function App() {
  const [month, setMonth] = useState(initialMonth)
  const [cutoff, setCutoff] = useState('12:30')
  const [selectedDay, setSelectedDay] = useState('2026-01-01')
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestId = useRef(0)

  async function loadData(forceRefresh = false) {
    const currentRequest = ++requestId.current
    setLoading(true); setError('')
    try {
      const response = await fetch(`/api/analysis?month=${encodeURIComponent(month)}&cutoff=${encodeURIComponent(cutoff)}${forceRefresh ? '&refresh=true' : ''}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`)
      if (currentRequest !== requestId.current) return
      setPayload(body)
      const firstDate = `${month}-01`
      setSelectedDay((old) => old.startsWith(month) ? old : firstDate)
    } catch (e) { if (currentRequest === requestId.current) setError(e.message || 'Could not load Elexon data.') }
    finally { if (currentRequest === requestId.current) setLoading(false) }
  }

  useEffect(() => { loadData() }, [month, cutoff])

  const metrics = payload?.metrics
  const daySeries = useMemo(() => (payload?.series || []).filter((p) => p.decisionDate === selectedDay), [payload, selectedDay])
  const chartRows = useMemo(() => daySeries.map((p) => ({ ...p, timeLabel: new Date(p.deliveryTime).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) })), [daySeries])
  const dailyRows = payload?.daily || []
  const connectionStatus = error ? 'DATA UNAVAILABLE' : loading ? 'UPDATING' : payload ? 'DATA CONNECTED' : 'NO DATA'

  function exportCsv() {
    const rows = payload?.series || []
    if (!rows.length) return
    const header = ['decision_date', 'delivery_hour_start_utc', 'forecast_published_utc', 'forecast_mw', 'hourly_mean_actual_mw', 'forecast_error_mw']
    const lines = [header.join(','), ...rows.map((p) => [p.decisionDate, p.deliveryTime, p.publishTime ?? '', p.forecastMw ?? '', p.actualMw ?? '', p.errorMw ?? ''].join(','))]
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
    link.download = `wind-ledger-${month}-decision-cutoff-${cutoff.replace(':', '')}.csv`
    link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Wind size={19} strokeWidth={2.2}/></div><div><span className="brand-name">wind ledger</span><span className="brand-sub">MARKET INTELLIGENCE</span></div></div>
      <div className="side-rule" />
      <div className="nav-label">WORKSPACE</div>
      <button className="nav-item active"><Activity size={17}/><span>Forecast review</span><span className="nav-pip"/></button>
      <div className="side-bottom"><div className="sidebar-card"><div className="sidebar-icon"><ShieldCheck size={16}/></div><div><strong>Decision aware</strong><p>Historical scores use only the forecast available at your cutoff.</p></div></div><div className="side-foot"><span className="status-dot"/>ELEXON INSIGHTS API <span className="side-version">v1</span></div></div>
    </aside>

    <main className="main">
      <header className="topbar"><div className="crumb"><span>Energy analytics</span><span className="crumb-slash">/</span><strong>Wind forecast</strong></div><div className="top-right"><div className="live-indicator"><span className={`status-dot ${loading ? 'busy' : error ? 'error' : ''}`}/>{connectionStatus}</div><div className="avatar">WL</div></div></header>

      <section className="content">
        <div className="heading-row"><div><div className="eyebrow"><span className="eyebrow-mark"/>DAY-AHEAD PROCUREMENT</div><h1>Wind forecast review</h1><p className="subtitle">See what was known at decision time. Measure what happened at delivery.</p></div><div className="heading-actions"><button className="button button-quiet" onClick={() => loadData(true)} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>Refresh</button><button className="button button-dark" onClick={exportCsv} disabled={!payload?.series?.length}><Download size={15}/>Export data</button></div></div>

        <section className="control-bar" aria-label="Analysis controls"><div className="control-item"><div className="control-icon"><CalendarDays size={16}/></div><label htmlFor="month">DECISION MONTH</label><input id="month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div><div className="control-divider"/><div className="control-item cutoff-control"><div className="control-icon"><Clock3 size={16}/></div><label htmlFor="cutoff">DECISION CUTOFF</label><input id="cutoff" type="time" value={cutoff} onChange={(e) => setCutoff(e.target.value)} /><span className="tz-tag">UK</span></div><div className="control-spacer"/><div className="assumption-note"><Info size={15}/><span>Default 12:30 is an assumption. Adjust to match your buying window.</span></div></section>

        {error ? <div className="error-panel"><div className="error-icon"><Info size={19}/></div><div><strong>We couldn’t load the Elexon data</strong><p>{error}</p><button className="text-button" onClick={() => loadData(true)}>Try again <ArrowUpRight size={13}/></button></div></div> : <>
          <div className="section-label-row"><div><span className="section-kicker">01</span><h2>Accuracy at a glance</h2></div><span className="period-chip"><span className="mini-dot"/>{monthLabel(month)} · Decision dates</span></div>
          <div className="metric-grid">
            <MetricCard label="MEAN ABSOLUTE ERROR" value={metrics?.maeMw} suffix="MW" sub="Typical miss per matched interval" icon={<Activity size={16}/>} loading={loading} />
            <MetricCard label="ROOT MEAN SQUARED ERROR" value={metrics?.rmseMw} suffix="MW" sub="Weights larger misses more" icon={<Zap size={16}/>} loading={loading} />
            <MetricCard label="FORECAST BIAS" value={metrics?.biasMw} suffix="MW" sub="Positive means forecast ran high" icon={metrics?.biasMw == null ? <Activity size={16}/> : metrics.biasMw >= 0 ? <ArrowUpRight size={16}/> : <ArrowDownRight size={16}/>} loading={loading} bias />
            <div className="metric-card coverage-card"><div className="metric-top"><span className="metric-label">DATA COVERAGE</span><span className="metric-icon"><Check size={16}/></span></div><div className="metric-value">{loading ? <Skeleton width="75px"/> : metrics?.coveragePct == null ? '—' : <>{oneDec.format(metrics.coveragePct)}<small>%</small></>}</div><div className="coverage-track"><div className="coverage-fill" style={{width:`${loading ? 0 : metrics?.coveragePct || 0}%`}}/></div><div className="metric-foot">{loading ? 'Loading paired intervals…' : `${fmt.format(metrics?.matchedIntervals || 0)} of ${fmt.format(metrics?.expectedIntervals || 0)} hourly periods paired`}</div></div>
          </div>

          <section className="chart-panel"><div className="panel-head"><div><div className="section-kicker">02 · INTERVAL VIEW</div><h2>Forecast against actual</h2><p>Decision-time forecast and generation outturn for one delivery day.</p></div><div className="day-picker"><CalendarDays size={15}/><select aria-label="Delivery day" value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)}>{dailyRows.map((d) => <option key={d.decisionDate} value={d.decisionDate}>{formatDate(d.decisionDate)} decision · delivers {formatDate(addDay(d.decisionDate, 1))}</option>)}</select><ChevronDown size={14}/></div></div>
            <div className="legend"><span><i className="legend-line forecast-line"/>Hourly wind forecast</span><span><i className="legend-line actual-line"/>Hourly mean actual</span><span className="legend-note">MW · hourly periods</span></div>
            <div className="chart-wrap">{loading ? <div className="loading-state"><LoaderCircle className="spin" size={22}/>Loading Elexon data</div> : chartRows.some((p) => p.forecastMw != null) ? <ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartRows} margin={{top:12,right:12,bottom:0,left:0}}><defs><linearGradient id="forecastShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#597c61" stopOpacity={0.15}/><stop offset="100%" stopColor="#597c61" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#e9e9e3" strokeDasharray="3 5"/><XAxis dataKey="timeLabel" tickLine={false} axisLine={false} tick={{fill:'#92958d',fontSize:11}} interval={3} dy={9}/><YAxis tickLine={false} axisLine={false} tick={{fill:'#92958d',fontSize:11}} tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} width={43}/><Tooltip content={<ChartTooltip/>}/><Area type="monotone" dataKey="forecastMw" stroke="none" fill="url(#forecastShade)" isAnimationActive={false}/><Line type="monotone" dataKey="forecastMw" name="Forecast" stroke="#547a5c" strokeWidth={2.4} dot={false} activeDot={{r:4,fill:'#547a5c',stroke:'#fff',strokeWidth:2}} connectNulls={false}/><Line type="monotone" dataKey="actualMw" name="Actual" stroke="#d48a56" strokeWidth={2.2} dot={false} activeDot={{r:4,fill:'#d48a56',stroke:'#fff',strokeWidth:2}} connectNulls={false}/></ComposedChart></ResponsiveContainer> : <div className="empty-chart"><Wind size={23}/><strong>No decision-time forecast found</strong><span>{chartRows.length ? 'No forecast was published by the selected cutoff.' : 'There is no Elexon data for this delivery day.'}</span></div>}</div>
            <div className="chart-bottom"><span><span className="bottom-dot green"/>Hourly outturn is the mean of its two FUELHH half-hour values.</span><span className="source-link"><ExternalLink size={12}/>Elexon WINDFOR + FUELHH</span></div>
          </section>

            <section className="lower-grid"><div className="daily-panel"><div className="panel-head compact"><div><div className="section-kicker">03 · PATTERN</div><h2>Daily forecast error</h2></div><span className="tiny-unit">MAE · MW</span></div><div className="daily-chart">{loading ? <div className="loading-state"><LoaderCircle className="spin" size={20}/>Loading</div> : dailyRows.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={dailyRows} margin={{top:12,right:9,bottom:0,left:0}} onClick={(e) => e?.activePayload?.[0]?.payload?.decisionDate && setSelectedDay(e.activePayload[0].payload.decisionDate)}><defs><linearGradient id="dailyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#729176" stopOpacity={0.22}/><stop offset="100%" stopColor="#729176" stopOpacity={0.02}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#e9e9e3" strokeDasharray="3 5"/><XAxis dataKey="decisionDate" tickFormatter={(v) => Number(v.slice(-2)) % 5 === 1 ? v.slice(-2) : ''} tickLine={false} axisLine={false} tick={{fill:'#92958d',fontSize:10}} dy={7}/><YAxis tickLine={false} axisLine={false} tick={{fill:'#92958d',fontSize:10}} width={38}/><Tooltip content={<DailyTooltip/>}/><Area type="monotone" dataKey="maeMw" stroke="#58785d" strokeWidth={1.8} fill="url(#dailyFill)" connectNulls={false} isAnimationActive={false} activeDot={{r:4,fill:'#58785d',stroke:'#fff',strokeWidth:2}}/></AreaChart></ResponsiveContainer> : null}</div><div className="daily-foot"><span>Click a point to inspect its delivery day.</span><span className="source-link">{dailyRows.length} decision dates</span></div></div>
            <div className="method-panel"><div className="section-kicker">HOW TO READ THIS</div><h2>Forecasts with a timestamp.</h2><p>Each interval uses the latest forecast published by the selected cutoff on its decision date. Revisions published later are excluded from the score.</p><div className="method-row"><span className="method-number">01</span><div><strong>Decision date</strong><span>Chosen month · local UK time</span></div></div><div className="method-row"><span className="method-number">02</span><div><strong>Delivery interval</strong><span>Following calendar day · hourly</span></div></div><div className="method-row"><span className="method-number">03</span><div><strong>Score only matched rows</strong><span>Coverage is shown beside each metric</span></div></div></div></section>

          <section className="table-panel"><div className="panel-head compact"><div><div className="section-kicker">04 · AUDIT TRAIL</div><h2>Intervals for {formatDate(selectedDay)}</h2></div><span className="table-count">{chartRows.length} periods</span></div><div className="table-scroll"><table><thead><tr><th>DELIVERY TIME</th><th>FORECAST PUBLISHED</th><th className="num">FORECAST MW</th><th className="num">HOURLY MEAN ACTUAL MW</th><th className="num">ERROR MW</th></tr></thead><tbody>{chartRows.slice(0,12).map((p) => <tr key={p.deliveryTime}><td className="mono">{new Date(p.deliveryTime).toLocaleTimeString('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'})}</td><td><span className="published"><span className="mini-dot"/>{p.publishTime ? new Date(p.publishTime).toLocaleString('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : 'No eligible forecast'}</span></td><td className="num">{p.forecastMw == null ? <span className="muted">—</span> : fmt.format(p.forecastMw)}</td><td className="num">{p.actualMw == null ? <span className="muted">—</span> : fmt.format(p.actualMw)}</td><td className={`num ${p.errorMw == null ? 'muted' : p.errorMw > 0 ? 'error-positive' : 'error-negative'}`}>{p.errorMw == null ? (p.actualMw == null ? 'No actual' : 'No eligible forecast') : `${p.errorMw > 0 ? '+' : ''}${fmt.format(p.errorMw)}`}</td></tr>)}</tbody></table>{chartRows.length > 12 && <div className="table-more">Showing first 12 intervals. Export CSV for the complete series.</div>}{!chartRows.length && <div className="table-more">No rows for the selected day.</div>}</div></section>
        </>}

        <footer className="footer"><div><Leaf size={14}/><span>Built for clarity at the point of decision.</span></div><div><span>Data: Elexon BMRS Insights</span><span className="footer-sep">·</span><span>All times Europe/London</span><span className="footer-sep">·</span><span>Forecast revisions preserved</span></div></footer>
      </section>
    </main>
  </div>
}

function MetricCard({label,value,suffix,sub,icon,loading,bias}) { const sign = bias && typeof value === 'number' && value > 0 ? '+' : ''; return <div className="metric-card"><div className="metric-top"><span className="metric-label">{label}</span><span className="metric-icon">{icon}</span></div><div className="metric-value">{loading ? <Skeleton width="92px"/> : value == null ? '—' : <>{sign}{oneDec.format(value)}<small>{suffix}</small></>}</div><div className="metric-foot">{bias && value != null ? <span className={`bias-tag ${value > 0 ? 'high' : value < 0 ? 'low' : ''}`}>{value > 0 ? 'HIGH' : value < 0 ? 'LOW' : 'NEUTRAL'}</span> : null}{sub}</div></div> }
function Skeleton({width}) { return <span className="skeleton" style={{width}}/> }
function ChartTooltip({active,payload,label}) { if(!active||!payload?.length)return null; const p=payload[0].payload; return <div className="tooltip"><span className="tooltip-time">{new Date(p.deliveryTime).toLocaleString('en-GB',{timeZone:'Europe/London',weekday:'short',hour:'2-digit',minute:'2-digit'})} UK</span><div><i className="tooltip-dot green"/>Forecast <strong>{p.forecastMw==null?'—':`${fmt.format(p.forecastMw)} MW`}</strong></div><div><i className="tooltip-dot orange"/>Actual <strong>{p.actualMw==null?'—':`${fmt.format(p.actualMw)} MW`}</strong></div><small>{p.publishTime ? `Published ${new Date(p.publishTime).toLocaleTimeString('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'})} UK` : 'No forecast published by cutoff'}</small></div> }
function DailyTooltip({active,payload}) { if(!active||!payload?.length)return null;const p=payload[0].payload;return <div className="tooltip"><span className="tooltip-time">Decision {formatDate(p.decisionDate)}</span><div>MAE <strong>{p.maeMw==null?'—':`${oneDec.format(p.maeMw)} MW`}</strong></div><small>{fmt.format(p.matched)} / {fmt.format(p.intervals)} matched intervals</small></div> }
function monthLabel(value){const d=new Date(`${value}-01T12:00:00`);return d.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}
function formatDate(value){return new Date(`${value}T12:00:00`).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
function addDay(value,n){const d=new Date(`${value}T12:00:00`);d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>)
