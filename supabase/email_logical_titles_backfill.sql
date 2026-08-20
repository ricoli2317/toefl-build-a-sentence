-- One-time, audit-friendly backfill for the 58 existing Email logical items.
-- This file is intentionally not executed by the application or any migration runner.
-- Review the preflight result before running this transaction manually.

begin;

create temporary table _email_title_backfill (
  display_number text primary key,
  old_title text not null,
  new_title text not null
) on commit drop;

insert into _email_title_backfill (display_number, old_title, new_title) values
  ('058', 'Request for additional cooking tips', 'Additional Cooking Tips'),
  ('057', 'Issue with online class platform', 'Online Class Platform Issue'),
  ('056', 'Request for letter of recommendation', 'Recommendation Letter Request'),
  ('055', 'Suggestions for expanding pastry selection', 'Expanded Pastry Selection'),
  ('054', 'Inquiry About Vacation Rental for Weekend Getaway', 'Weekend Vacation Rental'),
  ('053', 'Recent order', 'Recent Order'),
  ('052', 'Managing stress and workload', 'Stress and Workload Management'),
  ('051', 'Feedback on your seminar and a request', 'Seminar Feedback and Request'),
  ('050', 'Let’s study for the final exam', 'Final Exam Study Plan'),
  ('049', 'Upcoming team-building nature hike', 'Team-Building Nature Hike'),
  ('048', 'Inquiry About Costume Rentals for Community Theater', 'Community Theater Costume Rentals'),
  ('047', 'Damaged furniture item', 'Damaged Furniture Item'),
  ('046', 'Request for a meeting schedule change', 'Meeting Schedule Change'),
  ('045', 'Feedback on world history course', 'World History Course Feedback'),
  ('044', 'Suggestions for Enhancing Future Events', 'Future Event Improvements'),
  ('043', 'Concerns About Equipment', 'Equipment Concerns'),
  ('042', 'Request for Advice in Fitness Class', 'Fitness Class Advice'),
  ('041', 'Feedback on dining experience', 'Dining Experience Feedback'),
  ('040', 'Request for class notes', 'Class Notes Request'),
  ('039', 'Trip Accommodation Inquiry', 'Trip Accommodation Inquiry'),
  ('038', 'Weekend adventure', 'Weekend Adventure'),
  ('037', 'Internet connection issues in dormitory', 'Dormitory Internet Issues'),
  ('036', 'Recent Furniture Purchase', 'Recent Furniture Purchase'),
  ('035', 'Concerns About Communal Laundry Room', 'Laundry Room Concerns'),
  ('034', 'Catering service issues', 'Catering Service Issues'),
  ('033', 'Career Workshop', 'Career Workshop'),
  ('032', 'Suggestions for eco-friendly practices at the resort', 'Eco-Friendly Resort Practices'),
  ('031', 'Recent Laptop Purchase', 'Recent Laptop Purchase'),
  ('030', 'Feedback on dining experience', 'Dining Experience Feedback'),
  ('029', 'Arrangements for Surprise Birthday Party', 'Surprise Birthday Party'),
  ('028', 'Inquiry About Class Field Trip Travel Packages', 'Field Trip Travel Packages'),
  ('027', 'Printer Malfunction Issues', 'Printer Malfunction'),
  ('026', 'Damaged library book', 'Damaged Library Book'),
  ('025', 'Feedback on art gallery visit', 'Art Gallery Visit Feedback'),
  ('024', 'Request to discuss academic and work balance', 'Academic and Work Balance'),
  ('023', 'Printing Services for Upcoming Play', 'Play Printing Services'),
  ('022', 'Inquiry About Internship Program', 'Internship Program Inquiry'),
  ('021', 'Feedback on Hotel Stay', 'Hotel Stay Feedback'),
  ('020', 'Feedback on Recent Presentation', 'Presentation Feedback'),
  ('019', 'Lost Jacket Inquiry', 'Lost Jacket Inquiry'),
  ('018', 'Managing stress and workload', 'Stress and Workload Management'),
  ('017', 'Feedback on Recent Cake Purchase', 'Recent Cake Purchase Feedback'),
  ('016', 'Suggestion for updating gym equipment', 'Gym Equipment Update'),
  ('015', 'Issues with hotel room', 'Hotel Room Issues'),
  ('014', 'Resort Inquiry', 'Resort Inquiry'),
  ('013', 'Issues with group project', 'Group Project Issues'),
  ('012', 'Request for Lecture Notes', 'Lecture Notes Request'),
  ('011', 'Appreciation for group project contribution', 'Group Project Appreciation'),
  ('010', 'Issue with kitchen appliance purchase', 'Kitchen Appliance Issue'),
  ('009', 'Assistance with Biology Assignments', 'Biology Assignment Assistance'),
  ('008', 'Request for rescheduling yoga classes', 'Yoga Class Rescheduling'),
  ('007', 'Advice on yoga practice', 'Yoga Practice Advice'),
  ('006', 'Summer trip itinerary ideas', 'Summer Trip Itinerary'),
  ('005', 'Damaged furniture item', 'Damaged Furniture Item'),
  ('004', 'Internet connection issues in dormitory', 'Dormitory Internet Issues'),
  ('003', 'Request for apartment repairs', 'Apartment Repair Request'),
  ('002', 'Fundraising event planning', 'Fundraising Event Planning'),
  ('001', 'Ideas for recycling awareness event', 'Recycling Awareness Event');

-- Preflight: all 58 rows must exist and still have the audited old title.
select
  item.item_id,
  item.display_number,
  item.display_title as current_title,
  backfill.new_title
from public.practice_items item
join _email_title_backfill backfill
  on backfill.display_number = item.display_number
where item.task_type = 'email'
order by item.display_number desc;

do $$
declare
  v_plan_count integer;
  v_match_count integer;
  v_invalid_count integer;
begin
  select count(*) into v_plan_count from _email_title_backfill;

  select count(*) into v_match_count
  from public.practice_items item
  join _email_title_backfill backfill
    on backfill.display_number = item.display_number
   and backfill.old_title = item.display_title
  where item.task_type = 'email';

  select count(*) into v_invalid_count
  from _email_title_backfill
  where new_title !~ '^[A-Za-z][A-Za-z''-]*( [A-Za-z][A-Za-z''-]*){0,4}$';

  if v_plan_count <> 58 then
    raise exception 'Expected 58 planned Email titles, found %', v_plan_count;
  end if;
  if v_match_count <> 58 then
    raise exception 'Expected 58 unchanged Email rows, matched %; aborting', v_match_count;
  end if;
  if v_invalid_count <> 0 then
    raise exception 'Found % invalid English 1-5 word titles; aborting', v_invalid_count;
  end if;
end;
$$;

update public.practice_items item
set display_title = backfill.new_title
from _email_title_backfill backfill
where item.task_type = 'email'
  and item.display_number = backfill.display_number
  and item.display_title = backfill.old_title;

-- Postflight: this must return 58 rows and no mismatches.
select
  item.item_id,
  item.display_number,
  backfill.old_title,
  item.display_title as applied_title,
  item.display_title = backfill.new_title as matches_plan
from public.practice_items item
join _email_title_backfill backfill
  on backfill.display_number = item.display_number
where item.task_type = 'email'
order by item.display_number desc;

do $$
declare
  v_applied_count integer;
begin
  select count(*) into v_applied_count
  from public.practice_items item
  join _email_title_backfill backfill
    on backfill.display_number = item.display_number
   and backfill.new_title = item.display_title
  where item.task_type = 'email';

  if v_applied_count <> 58 then
    raise exception 'Expected 58 applied Email titles, found %; aborting', v_applied_count;
  end if;
end;
$$;

commit;
