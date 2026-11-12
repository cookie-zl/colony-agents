---
name: hologres-query
description: 在 Hologres 上写查询的规范：先 EXPLAIN 再跑数、分区裁剪、避免全表 DISTINCT、结果必须带行数与耗时。适用于带 jsonb 列的事实表。
whenToUse: 需要查 Hologres、排查慢查询、或从 jsonb 字段里取广告报表指标时使用。
---

# Hologres 查询规范

## 写查询前

1. 先 `SELECT * FROM <表> LIMIT 1` 看清字段类型。jsonb 列里的 key 容易拼错，
   拼错的 key 不会报错，只会返回 NULL——这是最常见的「查出来是空的」原因。
2. 确认分区键。带 `WHERE 分区键 = ...` 和不带，扫描量能差两个数量级。

## 硬性要求

- **jsonb 取值必须强转**：`(data->>'spend')::numeric`，不要直接比较字符串。
- **聚合前先去重**：报表可能一天多批写入，同一个 `(report_date, campaign_id)` 会有多行。
  先用 `SELECT ... GROUP BY 全部维度` 看一眼有没有重复，再决定是否 `DISTINCT ON`。
- **不写 `SELECT *`**：列存表里这会读全部列，比只读需要的列慢几倍。
- **给结果加行数**：查询结果末尾附 `-- rows: N, elapsed: Xms`，方便判断是不是被截断。

## 慢查询排查顺序

1. `EXPLAIN <查询>` 看有没有全表扫描；
2. 看 `WHERE` 里的字段是不是分布键/分区键；
3. 大表 join 时确认两侧都走了 distribution key，否则会 broadcast；
4. 以上都正常再考虑加索引或物化视图。

## 交付格式

```sql
-- 目的：一句话说明这个查询回答什么问题
-- rows: 预计量级
SELECT ...
```
